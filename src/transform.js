// 스크랩한 글을 한국어로 옮기거나 줄인다. API 키 없이 동작한다.
// - 초안: 전문 번역은 구글 번역 웹 주소, 요약은 기기 안에서 핵심 문장 고르기 (PC·모바일 같음)
// - 마무리: PC에 설치된 Claude Code(구독 계정, 실행은 src/claude.js)가 구글 번역문을 원문과 대조해 고칠 줄만 돌려주고,
//   요약은 원문을 읽고 새로 쓴다. Claude는 기사 전문 번역은 저작권 때문에 대부분 거절하므로 번역 자체는 구글이 한다
// - 모바일 초안은 노트에 "Claude 확인 대기" 표시를 남기고, PC 옵시디언이 동기화로 받으면 마무리한다 (src/pending.js, main.js)
import { plainText, tokenize } from "./related.js";

const GT_URL = "https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=ko&format=text";
const GT_MAX = 4500; // 요청 하나에 넣을 글 길이
const GT_BATCH = 20000; // 요청 하나에 넣을 글 길이 합

const HANGUL = /[가-힯]/g;
const CJK_KANA = /[぀-ヿ㐀-鿿]/g;
const WORDS = /[A-Za-zÀ-ɏЀ-ӿ]+/g;

// 한글이 글자의 절반을 넘으면 한국어 글. 영어 단어는 한 단어를 한글 1.5자로 친다 (IT 글의 영어 용어 때문에)
export function isKorean(markdown) {
  const t = plainText(markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, " "));
  const ko = (t.match(HANGUL) || []).length;
  const other = (t.match(CJK_KANA) || []).length + 1.5 * (t.match(WORDS) || []).length;
  if (!ko && !other) return true; // 글자가 없으면 번역할 것도 없다
  return ko / (ko + other) >= 0.5;
}

// ---------- 번역하면 깨지는 줄 지키기 ----------

const PH = (i) => `⟦${i}⟧`;

// 코드 블록, 표 구분선(| --- |), 이미지만 있는 줄, HTML, 구분선, 주소만 있는 줄
function isFixedLine(line) {
  const s = line.trim();
  if (!s) return false;
  if (/^[|:\s-]+$/.test(s) && s.includes("|") && s.includes("-")) return true;
  if (/^([-*_])(\s*\1){2,}$/.test(s)) return true;
  if (/^((!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]+\]\]|\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\))\s*)+$/.test(s)) return true;
  if (/^<[^>]+>(.*<\/[^>]+>)?$/.test(s)) return true;
  return /^<?https?:\/\/\S+>?$/.test(s);
}

/**
 * 깨지기 쉬운 부분을 ⟦0⟧ 같은 자리표시로 바꾼다. 구글 번역은 이 표시를 그대로 돌려준다.
 * - 줄 통째로: 코드 블록, 표 구분선, 이미지만 있는 줄, HTML, 구분선
 * - 줄 안에서: 이미지, 링크 주소, 맨 주소 (주소 속 영어 단어까지 번역되는 것을 막는다)
 * @returns {{text:string, pieces:{text:string, line:boolean}[]}}
 */
export function protect(md) {
  const pieces = [];
  const hold = (text, line) => (pieces.push({ text, line }), PH(pieces.length - 1));
  const inline = (line) =>
    line
      .replace(/!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]+\]\]/g, (m) => hold(m, false))
      .replace(/\]\(([^)\s]+)/g, (m, u) => "](" + hold(u, false))
      .replace(/https?:\/\/[^\s)>\]]+/g, (m) => hold(m, false));
  const out = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith(fence[1])) j++;
      out.push(hold(lines.slice(i, j + 1).join("\n"), true));
      i = j;
    } else {
      out.push(isFixedLine(lines[i]) ? hold(lines[i], true) : inline(lines[i]));
    }
  }
  return { text: out.join("\n"), pieces };
}

const PH_ANY = /^[ \t]*⟦(\d+)⟧[ \t]*$|[ \t]?⟦(\d+)⟧/gm;
const idsIn = (s) => [...s.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1]));

/** 자리표시를 되돌린다. expected(기본: 전부)에 있는 표시가 하나라도 없어졌으면 null */
export function restore(text, pieces, expected = pieces.map((_, i) => i)) {
  const seen = new Set();
  const out = text.replace(PH_ANY, (m, a, b) => {
    const n = Number(a ?? b);
    const p = pieces[n];
    if (!p) return m;
    if (seen.has(n)) return "";
    seen.add(n);
    if (a !== undefined) return p.text;
    // 줄 통째로였던 것이 줄 중간에 붙어 오면 줄을 나눠 되돌린다
    return p.line ? `\n${p.text}\n` : (m.startsWith(" ") || m.startsWith("\t") ? m[0] : "") + p.text;
  });
  return expected.every((n) => seen.has(n)) ? out : null;
}

// ---------- 구글 번역 (키 없는 웹 주소) ----------

/**
 * 여러 덩어리를 한국어로 옮긴다. 순서대로 같은 개수를 돌려준다.
 * @param {string[]} texts
 * @param {(url:string, body:string, contentType:string)=>Promise<{status:number, text:string}>} post
 */
export async function googleTranslate(texts, post) {
  const out = new Array(texts.length).fill("");
  let batch = [];
  let size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const body = batch.map((i) => "q=" + encodeURIComponent(texts[i])).join("&");
    const res = await post(GT_URL, body, "application/x-www-form-urlencoded;charset=UTF-8");
    if (res.status !== 200) throw new Error(`구글 번역이 응답하지 않습니다 (HTTP ${res.status})`);
    const j = JSON.parse(res.text);
    // 한 덩어리면 ["번역", "ja"], 여러 덩어리면 [["번역", "ja"], …]
    const rows = batch.length === 1 && !Array.isArray(j[0]) ? [j] : j;
    batch.forEach((idx, k) => {
      const row = rows[k];
      out[idx] = Array.isArray(row) ? String(row[0] ?? "") : String(row ?? "");
    });
    batch = [];
    size = 0;
  };
  for (let i = 0; i < texts.length; i++) {
    if (!texts[i].trim()) continue;
    if (size + texts[i].length > GT_BATCH) await flush();
    batch.push(i);
    size += texts[i].length;
  }
  await flush();
  return out;
}

// 빈 줄 기준으로 GT_MAX 이하 덩어리로 자른다 (구형 iOS 때문에 정규식 lookbehind는 쓰지 않는다)
function chunk(text, max = GT_MAX) {
  const out = [];
  let cur = "";
  const push = (s) => {
    if (cur && cur.length + s.length > max) {
      out.push(cur);
      cur = "";
    }
    cur += s;
  };
  const paras = text.split("\n\n").map((p, i, a) => (i < a.length - 1 ? p + "\n\n" : p));
  for (const para of paras) {
    if (para.length <= max) push(para);
    else (para.match(/[^\n]*\n|[^\n]+$/g) || []).forEach((line) => {
      if (line.length <= max) push(line);
      else (line.match(/[^.!?。！？]*[.!?。！？]+\s*|[^.!?。！？]+$/g) || [line]).forEach(push);
    });
  }
  if (cur) out.push(cur);
  return out;
}

// 덩어리 앞뒤 공백(줄바꿈)은 번역에 넘기지 않고 그대로 이어 붙인다
const keepEdges = (src, translated) => src.match(/^\s*/)[0] + translated.trim() + src.match(/\s*$/)[0];

/** 마크다운 글 전체를 구글 번역으로 옮긴다 */
export async function translateMarkdown({ title, markdown }, post) {
  const { text, pieces } = protect(markdown);
  const parts = chunk(text);
  const [t, ...outs] = await googleTranslate([title, ...parts.map((p) => p.trim())], post);
  let body = restore(parts.map((p, i) => (p.trim() ? keepEdges(p, outs[i]) : p)).join(""), pieces);
  if (body === null) {
    // 자리표시가 없어진 곳이 있으면 문단 단위로 다시 옮기고, 그래도 안 맞는 문단은 원문으로 둔다
    const blocks = text.split("\n\n");
    const tr = await googleTranslate(blocks.map((b) => b.trim()), post);
    body = blocks
      .map((b, i) => (b.trim() && restore(keepEdges(b, tr[i]), pieces, idsIn(b))) || restore(b, pieces, idsIn(b)))
      .join("\n\n");
  }
  return { title: t.trim() || title, markdown: tidy(body) };
}

// 줄 끝 공백, 겹친 빈 줄, 일본어 문단 첫머리의 전각 공백을 정리한다
function tidy(md) {
  return md.replace(/[ \t]+$/gm, "").replace(/^　+/gm, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------- 기기 안 요약: 핵심 문장 고르기 ----------

const BOILERPLATE =
  /[\w.-]+@[\w-]+\.[\w.]+|무단\s*(전재|복제)|재배포\s*금지|저작권자|copyright|all rights reserved|ⓒ|©|구독|좋아요|댓글|공유하기|(이미지|사진|그래픽)\s?확대|▶|☞|転載|著作権|^(―|—|─|ー){2}/i;

/** 문장 나누기. 。！？ 뒤, 또는 .!? 뒤에 공백이나 줄끝이 오면 끊는다 (3.5% 같은 숫자는 자르지 않는다) */
export function splitSentences(text) {
  const out = [];
  let cur = "";
  const closer = /["'”’」』)\]]/;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    cur += ch;
    const cjkEnd = "。！？".includes(ch);
    const latEnd = ".!?…".includes(ch) && (i + 1 >= text.length || /\s/.test(text[i + 1]) || closer.test(text[i + 1]));
    if (cjkEnd || latEnd) {
      while (i + 1 < text.length && closer.test(text[i + 1])) cur += text[++i];
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// 문장이 끝난 줄: 마침표류, 한국어 종결 어미, ㅋㅋ·이모지
const LINE_END = /([.!?。！？…"”'’」』)]|[다요죠까네지음함됨임]|[ㄱ-ㅎ]|\p{Extended_Pictographic})$/u;

// 본문을 문장 후보로 바꾼다. 소제목·이미지·표·코드는 빼고, 끝맺지 않은 줄(줄마다 끊어 쓴 블로그 글)은 다음 줄과 이어 붙인다
function candidates(markdown) {
  const md = markdown.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, "");
  const units = [];
  let carry = "";
  const flush = () => carry && (units.push(carry), (carry = ""));
  let afterImage = false;
  for (const raw of md.split("\n").map((l) => l.trim())) {
    if (!raw) continue;
    const bare = raw.replace(/^(\*\*|__|>\s?)+/, "").replace(/^[\s　]+/, "");
    // 이미지 줄(「이미지 확대」 같은 말만 붙은 것 포함)과, 바로 뒤에 오는 뉴스 사진 제목(굵은 줄)·설명((서울=연합뉴스) …)
    const wasImage = afterImage;
    afterImage =
      (/!\[/.test(raw) && plainText(raw).replace(/[*_\s]|(이미지|사진|그래픽)\s?확대/g, "").length < 12) ||
      (wasImage && /^(\*\*|__).{1,60}(\*\*|__)$/.test(raw));
    if (afterImage || (wasImage && /^\([^()]{1,20}=[^()]{1,20}\)/.test(bare))) {
      flush();
      continue;
    }
    // 소제목·표·이미지, 인터뷰어 질문(――), 굵은 말머리 줄(**宮本**), 끝맺지 않은 ◇·■ 소제목
    if (
      /^#{1,6}\s|^\||^!\[|^\[!\[|^<|^([-*_])(\s*\1){2,}$/.test(raw) ||
      /^(―|—|─|ー){2}/.test(bare) ||
      /^(\*\*|__)[^*_]{1,12}(\*\*|__)$/.test(raw) ||
      (/^[◇◆■□●○▲△▷▶【［\[]/.test(bare) && !/[.。!?！？]$/.test(raw))
    ) {
      flush();
      continue;
    }
    const isItem = /^([-*+]|\d+[.)])\s+/.test(raw);
    const line = plainText(raw.replace(/^>\s?/, "").replace(/^([-*+]|\d+[.)])\s+/, ""))
      .replace(/\*\*|__|`/g, "")
      .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1")
      .replace(/^[\s　]+/, "")
      // 인터뷰 말머리 (藤林氏： / 후지바야시 씨: )
      .replace(/^[^\s：:。、.,!?]{1,12}(\s?(氏|さん|씨))?\s?：\s*|^[가-힯぀-ヿ㐀-鿿]{1,8}(\s?(氏|さん|씨))?\s?:\s*/u, "")
      // 기사 첫머리 기자 표시 ((서울=연합뉴스) 홍길동 기자 = )
      .replace(/^\([^()]{1,20}=[^()]{1,20}\)\s*([가-힯]{2,4}\s?(기자|특파원)\s?)?=?\s*|^[가-힯]{2,4}\s?(기자|특파원)\s?=\s*/, "")
      .trim();
    if (!line) continue;
    if (isItem) {
      flush();
      units.push(line);
      continue;
    }
    carry = carry ? `${carry} ${line}` : line;
    if (LINE_END.test(line) || carry.length > 300) flush();
  }
  flush();
  const out = [];
  for (const u of units) for (const s of splitSentences(u)) out.push(s);
  return out.filter((s) => s.length >= 12 && s.length <= 400 && !BOILERPLATE.test(s));
}

/**
 * 글에서 중심이 되는 문장을 골라 원래 순서대로 돌려준다 (TextRank: 다른 문장과 많이 겹치는 문장이 중심).
 * 첫머리 문장과 제목과 겹치는 문장에 가산점, 이미 고른 문장과 거의 같은 문장은 건너뛴다.
 */
export function keySentences(title, markdown, { max = 6 } = {}) {
  const sents = candidates(markdown);
  const n = sents.length;
  if (n <= 3) return sents;
  const k = Math.min(max, Math.max(3, Math.round(Math.sqrt(n))));

  const toks = sents.map((s) => tokenize(s));
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
  const vec = (tokens) => {
    const tf = new Map();
    for (const w of tokens) tf.set(w, (tf.get(w) || 0) + 1);
    const v = new Map();
    let norm = 0;
    for (const [w, c] of tf) {
      const x = (1 + Math.log(c)) * Math.log((n + 1) / ((df.get(w) || 0) + 1));
      if (x > 0) v.set(w, x), (norm += x * x);
    }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const cos = (a, b) => {
    let dot = 0;
    const [s, l] = a.v.size < b.v.size ? [a, b] : [b, a];
    for (const [w, x] of s.v) {
      const y = l.v.get(w);
      if (y) dot += x * y;
    }
    return dot / (a.norm * b.norm);
  };
  const vs = toks.map(vec);
  const tv = vec(tokenize(title));
  const sim = vs.map((a, i) => vs.map((b, j) => (i === j ? 0 : cos(a, b))));
  const out = sim.map((row) => row.reduce((x, y) => x + y, 0) || 1);

  // 첫머리·제목 쪽으로 기울인 PageRank
  const bias = vs.map((v, i) => (1 + 2 * cos(v, tv)) * (1 + 1 / (1 + i / 3)));
  const bsum = bias.reduce((a, b) => a + b, 0);
  let r = new Array(n).fill(1 / n);
  for (let it = 0; it < 30; it++) {
    r = r.map((_, i) => {
      let s = 0;
      for (let j = 0; j < n; j++) if (sim[j][i]) s += (sim[j][i] / out[j]) * r[j];
      return 0.15 * (bias[i] / bsum) + 0.85 * s;
    });
  }
  // 첫머리 문장·제목과 겹치는 문장은 한 번 더 올리고, 질문은 요지가 아닌 경우가 많아 내린다
  const score = r.map(
    (x, i) => x * (1 + 0.6 * Math.exp(-i / 4)) * (1 + cos(vs[i], tv)) * (/[?？]["'”’」』)]*$/.test(sents[i]) ? 0.5 : 1)
  );

  const picked = [];
  for (const i of [...score.keys()].sort((a, b) => score[b] - score[a])) {
    if (picked.length >= k) break;
    if (picked.some((j) => sim[i][j] > 0.4)) continue;
    picked.push(i);
  }
  return picked.sort((a, b) => a - b).map((i) => sents[i]);
}

// 요약 맨 위에 둘 대표 이미지 (본문의 첫 이미지 줄)
export function leadImage(markdown) {
  const m = markdown.match(/^[ \t]*(!\[[^\]]*\]\([^)]+\)|!\[\[[^\]]+\]\])[ \t]*$/m);
  return m ? m[1] + "\n\n" : "";
}

async function localSummary({ title, markdown }, translate, post) {
  const sents = keySentences(title, markdown);
  let t = title;
  let lines = sents;
  if (translate) [t, ...lines] = await googleTranslate([title, ...sents], post);
  return { title: t.trim() || title, markdown: leadImage(markdown) + lines.map((s) => `- ${s.trim()}`).join("\n") + "\n" };
}

// ---------- Claude Code ----------

/** Claude에게 줄 지시문과 글 (요약, 또는 원문 언어로 나온 요약문의 번역) */
export function claudePrompt({ title, markdown }, { translate, summary }) {
  const rules = [];
  const lang = translate ? "한국어" : "원문과 같은 언어(일본어 글이면 일본어, 영어 글이면 영어)";
  if (summary) {
    rules.push(`아래 글을 ${lang}로 요약한다.`);
    rules.push(`첫 줄은 "# " 뒤에 ${translate ? "원래 제목을 한국어로 충실히 옮겨" : "원래 제목을 그대로"} 쓰고(새 제목을 짓지 않는다), 빈 줄 다음부터 요약을 쓴다.`);
    rules.push("분량은 원문의 5분의 1 이내, 길어도 1,000자 정도로 한다.");
    rules.push("첫 문단에 글의 요지를 한두 문장으로 쓰고, 이어서 중요한 사실·수치·주장·결론을 '- ' 항목 3~7개로 정리한다. 짧은 글이면 문단만 써도 된다.");
    rules.push("항목 앞에 '주제:' 같은 머리표나 굵은 소제목을 달지 않고 문장으로 쓴다. 한국어로 쓸 때는 '~했다', '~이다'로 끝나는 문어체로 쓴다.");
    rules.push("원문에 없는 해석·평가·배경지식은 덧붙이지 않는다. '이 글은', '요약하면' 같은 머리말 없이 바로 내용을 쓴다. 이미지·링크는 넣지 않는다.");
  } else {
    // 원문 언어로 나온 요약을 한국어로 옮길 때만 쓴다
    rules.push("아래 요약문을 한국어로 번역한다. 빠뜨리거나 덧붙이지 않는다.");
    rules.push('첫 줄은 "# 번역한 제목", 빈 줄 다음부터 본문을 쓴다. 마크다운 구조는 그대로 두고, \'~했다\', \'~이다\'로 끝나는 문어체로 쓴다.');
  }
  if (translate) rules.push("고유명사는 한국 정식 명칭이 있으면 그것을 쓰고(게임·작품·회사·인물), 없으면 원어 발음대로 한글로 적는다. 한자·가나를 섞어 쓰지 않는다.");
  // 글이 길면 앞의 지시를 잊고 원문 언어로 쓰는 일이 있어, 글 뒤에 출력 언어를 한 번 더 적는다
  return `${rules.map((r) => `- ${r}`).join("\n")}\n\n<article>\n# ${title}\n\n${markdown.trim()}\n</article>\n\n위 글을 ${summary ? "요약" : "번역"}한 결과만 ${lang}로 출력한다.\n`;
}

/** "# 제목\n\n본문" 형태의 응답을 나눈다 */
export function parseClaude(text, fallbackTitle) {
  const t = text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/, "$1").trim();
  const m = t.match(/^#\s+(.+)\n+/);
  if (!m) return { title: fallbackTitle, markdown: t };
  return { title: m[1].replace(/\*\*|__/g, "").trim() || fallbackTitle, markdown: t.slice(m[0].length) };
}

/** Claude가 응답은 했지만 쓸 수 없는 결과(거절 등)나 원문 본문이 없는 경우. 다시 시도해도 같을 가능성이 높아 다시 시도하지 않는다 */
export class ClaudeRefused extends Error {}

async function claudeSummary(a, translate, runClaude) {
  // 출력 언어와 머리말 금지는 시스템 지시에 둬야 지켜진다 (본문 지시만으로는 일본어로 요약하거나 "이 글은 …"으로 시작한다)
  const lang = translate ? "Write the entire output in Korean." : "Write in the same language as the article.";
  const system = `${lang} Never refer to the article itself (no openings like '이 글은', '이 기사는', 'この記事は', 'This article'); state its content directly, with the people or things it is about as subjects.`;
  // 이미지 주소는 요약에 필요 없으니 빼고 보낸다
  const md = a.markdown.replace(/^[ \t]*(!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]+\]\])[ \t]*$/gm, "");
  let r = parseClaude(await runClaude(claudePrompt({ title: a.title, markdown: md }, { translate, summary: true }), { system }), a.title);
  // 그래도 원문 언어로 요약해 오면, 짧은 요약문만 다시 번역시킨다
  const korean = (x) => isKorean(`${x.title}\n${x.markdown}`);
  if (translate && !korean(r)) {
    r = parseClaude(await runClaude(claudePrompt(r, { translate: true, summary: false }), { system }), r.title);
    if (!korean(r)) throw new ClaudeRefused("한국어로 요약하지 못했습니다");
  }
  if (!r.markdown.trim()) throw new ClaudeRefused("요약이 비어 있습니다");
  return { title: r.title, markdown: tidy(r.markdown) };
}

// ---------- Claude 확인: 구글 번역문을 원문과 대조해 고칠 줄만 받는다 ----------
// 고친 줄만 돌려받으므로 출력이 짧고, 고친 줄은 자리표시(이미지·링크 주소)와 줄 앞 마크다운 기호가 그대로일 때만 쓴다.

const hasWords = (line) => /[\p{L}\p{N}]/u.test(line.replace(/⟦\d+⟧/g, ""));
// 원문은 읽기만 하므로 링크 주소 자리를 지운다
const bareSource = (line) => line.replace(/\]\(⟦\d+⟧\)/g, "]").replace(/[ \t]?⟦\d+⟧/g, "").trim();
const MD_PREFIX = /^[ \t]*((?:[-*+]|\d+[.)]|#{1,6}|>)[ \t]+)*/;
const placeholders = (s) => (s.match(/⟦\d+⟧/g) || []).sort().join();

const REVIEW_RULES = `고칠 것:
- 오역, 빠뜨리거나 덧붙인 내용
- 한자·가나로 된 고유명사(게임·작품·회사·인물·지명): 한국 정식 명칭이 있으면 그것을, 없으면 원어 발음대로 한글로 적는다. 로마자 이름은 번역에 적힌 대로 둔다
- 뜻이 통하지 않거나 한국어로 어색한 문장
- 한 글 안에서 섞인 말투: 원문의 말투를 따른다(인터뷰 대답은 ~습니다, 지문은 ~다처럼). 섞이지 않았으면 말투는 바꾸지 않는다

쓰는 법:
- 고친 줄만 "[번호] 고친 번역" 형식으로 한 줄에 하나씩 쓴다. 고치지 않은 줄은 쓰지 않는다
- ⟦숫자⟧는 이미지·링크 주소 자리이니 빼거나 옮기지 말고 그대로 둔다. 줄 앞의 #, -, >, 1. 같은 마크다운 기호와 **, [ ]도 그대로 둔다
- 한 줄은 한 줄로 고친다. 원문의 내용은 하나도 빠뜨리지 않는다. 한자·가나를 섞어 쓰지 않고, 원문에 없는 설명을 덧붙이지 않는다
- 고칠 줄이 없으면 "없음"만 쓴다`;

const REVIEW_CHUNK = 8000; // 한 번에 확인할 원문+번역 글자 수 (긴 글을 한 번에 맡기면 응답이 5분을 넘는다)
const REVIEW_PARALLEL = 2; // 동시에 띄울 Claude 수 (하나에 200MB 남짓)

/**
 * 검토 계획: 원문과 번역의 글자 있는 줄 수가 같으면(구글 번역은 줄 구조를 지킨다) 줄마다 원문·번역을 짝지어 보여 주고,
 * 다르면(휴대폰 초안 뒤에 원문이 바뀐 경우 등) 원문과 번호 붙인 번역을 따로 보여 준다. 긴 글은 줄 묶음으로 나눈다.
 */
export function reviewPlan(a, draft) {
  const src = protect(a.markdown).text.split("\n").filter(hasWords).map(bareSource);
  const { text, pieces } = protect(draft.markdown);
  const lines = text.split("\n");
  const ids = lines.map((l, i) => (hasWords(l) ? i : -1)).filter((i) => i >= 0);
  const paired = src.length === ids.length;
  const ratio = src.length / Math.max(1, ids.length);
  const groups = [];
  let cur = [];
  let size = 0;
  ids.forEach((i, k) => {
    const len = lines[i].length + (paired ? src[k].length : ratio * lines[i].length);
    if (cur.length && size + len > REVIEW_CHUNK) {
      groups.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(k + 1); // 번역 줄 번호 (1부터, 0은 제목)
    size += len;
  });
  if (cur.length || !groups.length) groups.push(cur);
  return { a, draft, src, lines, ids, pieces, paired, groups };
}

/** 줄 묶음 하나의 검토 지시문 */
export function reviewPrompt(plan, nums, glossary = "") {
  const { a, draft, src, lines, ids, paired, groups } = plan;
  const first = !nums.length || nums[0] === 1;
  const part = groups.length > 1 ? " 글이 길어 일부분만 보여 준다." : "";
  let intro;
  let body;
  if (paired) {
    intro = `아래는 웹 글의 원문과, 사용자가 읽으려고 그 글을 구글 번역으로 옮긴 한국어 번역이다. [번호]마다 원문 한 줄과 그 번역이 있다.${first ? " [0]은 제목이다." : ""}${part}`;
    const items = nums.map((k) => `[${k}]\n원문: ${src[k - 1]}\n번역: ${lines[ids[k - 1]]}`);
    if (first) items.unshift(`[0]\n원문: ${a.title}\n번역: ${draft.title}`);
    body = items.join("\n\n");
  } else {
    // 짝을 못 지으면 이 묶음에 해당하는 원문을 비율로 잘라 앞뒤를 넉넉히 보여 준다
    const ratio = src.length / Math.max(1, ids.length);
    const from = groups.length > 1 ? Math.max(0, Math.floor((nums[0] - 1) * ratio) - 8) : 0;
    const to = groups.length > 1 ? Math.min(src.length, Math.ceil(nums[nums.length - 1] * ratio) + 8) : src.length;
    intro = `<원문>은 웹 글이고, <번역>은 사용자가 읽으려고 그 글을 구글 번역으로 옮긴 한국어 번역이다. 번역의 줄마다 앞에 [번호]가 있다.${first ? " [0]은 제목이다." : ""}${part}`;
    body = `<원문>\n${first ? `# ${a.title}\n\n` : ""}${src.slice(from, to).join("\n\n")}\n</원문>\n\n<번역>\n${first ? `[0] ${draft.title}\n` : ""}${nums.map((k) => `[${k}] ${lines[ids[k - 1]]}`).join("\n")}\n</번역>`;
  }
  const terms = glossary ? `\n\n고유명사는 아래 표기를 따른다:\n${glossary}` : "";
  return `${intro}\n번역을 원문과 대조해 고쳐야 할 줄만 고친다.\n\n${REVIEW_RULES}${terms}\n\n${body}\n\n고친 줄만 "[번호] 고친 번역" 형식으로 쓴다.\n`;
}

// 글을 나눠 확인할 때 묶음마다 고유명사를 다르게 옮기지 않도록, 먼저 표기를 정한다 (한자·가나 글만)
// 보통 낱말까지 넣으면 발음대로 옮긴 표기(謎のゴーレム → 나조노 고렘)가 본문 전체에 퍼지므로 고유명사로 좁힌다
export async function claudeGlossary(plan, runClaude) {
  const out = await runClaude(
    `아래 글에 나오는 고유명사 가운데 한자·가나로 쓴 것을 한국어 표기와 함께 적는다. 고유명사는 사람·캐릭터·작품·게임·회사·지명의 이름이다.
- 한 줄에 하나씩 "원어 → 한국어" 형식으로 쓴다
- 한국에 정식으로 나온 이름이 있으면 그것을 쓴다(예: 空の軌跡 → 하늘의 궤적)
- 사람·캐릭터·회사·지명은 원어 발음대로 한글로 적는다(예: 宮本茂 → 미야모토 시게루). 작품·게임·아이템 이름처럼 뜻이 있는 이름은 뜻을 살려 옮긴다
- 보통 낱말, 사자성어, 무언가를 설명하는 말(예: 一騎当千, 謎の男)은 넣지 않는다. 로마자로 쓴 이름도 넣지 않는다
- 표만 쓰고 설명은 덧붙이지 않는다. 없으면 "없음"만 쓴다

<글>
# ${plan.a.title}

${plan.src.join("\n")}
</글>
`,
    { system: "Write the entire output in Korean." }
  );
  return out
    .split("\n")
    .map((l) => l.replace(/^[-*\s]+/, "").trim())
    .filter((l) => /^[^→]{1,40}→[^→]{1,40}$/.test(l))
    .slice(0, 80)
    .join("\n");
}

// 비동기 작업을 n개씩 동시에
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** "[3] 고친 번역" 줄들을 읽는다. "[3]" 다음 줄에 쓰거나 "번역:"을 붙여 쓴 경우도 받는다 */
export function parseFixes(out) {
  const fixes = new Map();
  let cur = null;
  for (const raw of out.replace(/\r\n/g, "\n").split("\n")) {
    const m = raw.match(/^\s*\[(\d+)\]\s*(.*)$/);
    if (m) {
      cur = Number(m[1]);
      fixes.set(cur, m[2]);
    } else if (cur !== null && !fixes.get(cur).trim() && raw.trim() && !/^\s*원문\s*[:：]/.test(raw)) {
      fixes.set(cur, raw);
    }
  }
  for (const [k, v] of fixes) {
    const t = v.replace(/^\s*번역\s*[:：]\s*/, "").trim();
    if (t) fixes.set(k, t);
    else fixes.delete(k);
  }
  return fixes;
}

/**
 * 구글 번역 초안을 Claude가 원문과 대조해 고친다.
 * @param {{title:string, markdown:string}} a  원문
 * @param {{title:string, markdown:string}} draft  한국어 초안 (방금 만든 구글 번역, 또는 휴대폰에서 저장한 노트 본문)
 * @param {{progress?:(done:number, total:number)=>void}} [opts]
 * @returns {Promise<{title:string, markdown:string, fixes:number}>}
 */
export async function claudeReview(a, draft, runClaude, { progress } = {}) {
  const plan = reviewPlan(a, draft);
  const { lines, ids, pieces, groups } = plan;
  const system = "Write the entire output in Korean.";
  let glossary = "";
  if (groups.length > 1 && (a.markdown.match(CJK_KANA) || []).length > 200) {
    try {
      glossary = await claudeGlossary(plan, runClaude);
    } catch (e) {
      if (e instanceof ClaudeRefused) glossary = "";
      else throw e;
    }
  }
  let finished = 0;
  const outs = await pool(groups, REVIEW_PARALLEL, async (nums) => {
    const out = await runClaude(reviewPrompt(plan, nums, glossary), { system });
    if (progress) progress(++finished, groups.length);
    return out;
  });
  // 묶음마다 "[번호] 고친 줄"이 있거나 "없음"이어야 한다. 하나도 없으면(거절 등) 쓸 수 없는 결과
  const fixes = new Map();
  let answered = 0;
  for (const out of outs) {
    const f = parseFixes(out);
    if (f.size || /^\W*없음/.test(out.trim())) answered++;
    for (const [k, v] of f) fixes.set(k, v);
  }
  if (!answered) throw new ClaudeRefused(`번역을 확인하지 않았습니다: ${outs[0].trim().split("\n")[0].slice(0, 80)}`);
  let title = draft.title;
  let n = 0;
  for (const [k, v] of fixes) {
    if (k === 0) {
      const t = v.replace(/^#+\s*/, "").replace(/\*\*|__/g, "").trim();
      if (t && !t.includes("⟦")) (title = t), n++;
      continue;
    }
    const i = ids[k - 1];
    if (i === undefined) continue;
    const old = lines[i];
    const fixed = old.match(MD_PREFIX)[0] + v.replace(MD_PREFIX, "");
    // 이미지·링크 자리가 빠졌거나, 고친 줄이 크게 줄었거나(내용을 빠뜨렸을 수 있다), 깨진 글자(�)가 섞였으면 구글 번역 그대로 둔다
    if (placeholders(fixed) !== placeholders(old)) continue;
    if (old.length > 40 && fixed.length < old.length * 0.5) continue;
    if (fixed.includes("�") && !old.includes("�")) continue;
    lines[i] = fixed;
    n++;
  }
  const body = restore(lines.join("\n"), pieces);
  if (body === null) throw new ClaudeRefused("번역을 되돌리지 못했습니다");
  return { title, markdown: tidy(body), fixes: n, parts: groups.length, answered };
}

/** 제목 하나를 Claude로 한국어로 옮긴다 (외국어 제목 노트의 별칭용) */
export async function claudeTitle(title, runClaude) {
  const out = await runClaude(
    `다음 글 제목을 한국어로 옮긴다. 게임·작품·회사·인물은 한국 정식 명칭이 있으면 그것을 쓴다. 옮긴 제목 한 줄만 출력한다.\n\n${title}\n`,
    { system: "Write the entire output in Korean." }
  );
  const t = out.trim().split("\n")[0].replace(/^#\s+/, "").replace(/^"(.*)"$/, "$1").trim();
  if (!t || !isKorean(t)) throw new ClaudeRefused("제목을 한국어로 옮기지 못했습니다");
  return t;
}

/** 제목 하나를 구글 번역으로 옮긴다 */
export async function googleTitle(title, post) {
  const [t] = await googleTranslate([title], post);
  return t.trim();
}

// ---------- 진입점 ----------

/**
 * 초안을 Claude로 마무리한다. 요약은 원문을 읽고 새로 쓰고(초안의 대표 이미지는 살린다), 번역은 구글 번역 초안의 고칠 줄만 고친다.
 * @param {{title:string, markdown:string}} a  원문
 * @param {null | {title:string, markdown:string}} draft  초안 (요약은 없어도 된다)
 * @param {{translate:boolean, summary:boolean}} jobs
 * @param {{progress?:(done:number, total:number)=>void}} [opts]  긴 번역을 나눠 확인할 때 진행 상황
 */
export async function finishDraft(a, draft, jobs, runClaude, opts = {}) {
  if (jobs.summary) {
    const r = await claudeSummary(a, jobs.translate, runClaude);
    return { title: r.title, markdown: (leadImage(draft ? draft.markdown : "") || leadImage(a.markdown)) + r.markdown };
  }
  return claudeReview(a, draft, runClaude, opts);
}

/**
 * @param {{title:string, markdown:string, fallback?:boolean}} a  스크랩한 글 (fallback: 미리보기만 있는 글)
 * @param {{translate:boolean, summary:boolean}} mode
 * @param {{post:Function, runClaude?:(prompt:string, opts?:{system?:string})=>Promise<string>, progress?:(msg:string)=>void}} deps
 *        runClaude가 있으면(PC) 초안을 Claude로 마무리한다
 * @returns {Promise<null | {title:string, markdown:string, translated:boolean, summarized:boolean, done:boolean, retry:boolean, warning:string}>}
 *          바꿀 것이 없으면(한국어 글을 번역만 하려는 경우 등) null.
 *          done: Claude가 마무리함 / retry: 초안이라 나중에 Claude가 마무리하면 좋음 (Claude가 없거나 실행되지 않은 경우)
 */
export async function transformArticle(a, mode, deps) {
  const translate = !!mode.translate && !isKorean(`${a.title}\n${a.markdown}`);
  const summary = !!mode.summary && !a.fallback;
  if (!translate && !summary) return null;
  const say = deps.progress || (() => {});
  const jobs = { translate, summary };
  const base = { translated: translate, summarized: summary };
  if (!summary) say("구글 번역 중…");
  const draft = summary ? null : await translateMarkdown(a, deps.post);
  if (deps.runClaude) {
    say(summary ? "Claude가 요약하는 중…" : "Claude가 번역을 확인하는 중… (긴 글은 1~2분)");
    const progress = (d, n) => n > 1 && say(`Claude가 번역을 확인하는 중… (${d}/${n})`);
    try {
      const r = await finishDraft(a, draft, jobs, deps.runClaude, { progress });
      const warning = r.answered < r.parts ? `글이 길어 ${r.parts}부분으로 나눠 확인했는데 ${r.parts - r.answered}부분은 Claude가 확인하지 않아 구글 번역 그대로 두었습니다` : "";
      return { ...base, ...r, done: true, retry: false, warning };
    } catch (e) {
      // Claude가 실행되지 않았으면(로그인 만료·사용량 한도·시간 초과) 나중에 다시, 응답했는데 쓸 수 없으면 초안 그대로
      const retry = !(e instanceof ClaudeRefused);
      const what = summary ? "요약하지 못해 핵심 문장 고르기로 대신했습니다" : "번역을 확인하지 못해 구글 번역 그대로 저장했습니다";
      const r = draft || (await localSummary(a, translate, deps.post));
      return { ...base, ...r, done: false, retry, warning: `Claude가 ${what} (${e.message || e})` };
    }
  }
  if (summary) say("요약하는 중…");
  return { ...base, ...(draft || (await localSummary(a, translate, deps.post))), done: false, retry: true, warning: "" };
}
