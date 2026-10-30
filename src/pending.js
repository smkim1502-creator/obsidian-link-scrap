// 무료 방식(구글 번역·핵심 문장 고르기)으로 만든 초안에 "Claude 확인 대기" 표시를 달고, PC에서 그 표시를 읽어 마무리한다.
// 표시는 frontmatter 한 줄:  Claude: 번역 확인 대기 (3f2a1b9c)
//   - 앞말: Claude가 할 일. 번역 = 구글 번역문을 원문과 대조해 고치기, 요약 = 원문을 읽고 요약 새로 쓰기,
//           별칭 = 외국어 제목의 한국어 별칭 다시 옮기기. 여럿이면 ·로 잇는다
//   - 괄호: 초안의 지문. 휴대폰에서 노트를 고쳤으면 지문이 달라지므로, 고친 내용을 덮어쓰지 않는다

export const KEY = "Claude";
const WORDS = [
  ["translate", "번역"],
  ["summary", "요약"],
  ["alias", "별칭"],
];
const LINE = new RegExp(`^${KEY}:[ \\t]*"?(.+?) 확인 대기 \\(([0-9a-f]{8})\\)"?[ \\t]*$`);

/** FNV-1a 32비트 → 16진수 8자리 */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const norm = (s) => String(s || "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

/** Claude가 고칠 부분(제목·본문, 별칭)의 지문 */
export function draftHash({ title, body, aliases }, jobs) {
  const parts = [];
  if (jobs.translate || jobs.summary) parts.push(`# ${norm(title)}\n\n${norm(body)}`);
  if (jobs.alias) parts.push((aliases || []).map(norm).join("\n"));
  return fnv(parts.join("\n\n"));
}

export const hasJobs = (jobs) => !!jobs && WORDS.some(([k]) => jobs[k]);

/** frontmatter에 넣을 표시 줄 */
export function markerLine(jobs, hash) {
  return `${KEY}: ${WORDS.filter(([k]) => jobs[k]).map(([, w]) => w).join("·")} 확인 대기 (${hash})`;
}

/** frontmatter 값 하나를 읽는다 ("…", '…', 그냥 값) */
function unquote(v) {
  v = v.trim();
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function readAliases(fmLines) {
  const i = fmLines.findIndex((l) => /^aliases:/.test(l));
  if (i < 0) return [];
  const inline = fmLines[i].slice("aliases:".length).trim();
  if (inline) {
    if (inline.startsWith("[")) return inline.slice(1, -1).split(",").map(unquote).filter(Boolean);
    return [unquote(inline)];
  }
  const out = [];
  for (let j = i + 1; j < fmLines.length && /^[ \t]+-/.test(fmLines[j]); j++) out.push(unquote(fmLines[j].replace(/^[ \t]+-[ \t]*/, "")));
  return out.filter(Boolean);
}

/**
 * 스크랩 노트를 나눈다: frontmatter 줄들 / 제목 앞(관련 노트 줄) / "# 제목" / 본문
 * @returns {null | {fm:string[], pre:string, title:string, body:string, url:string, aliases:string[], jobs:null|{translate:boolean, summary:boolean, alias:boolean}, hash:string}}
 */
export function parseNote(text) {
  text = text.replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---[ \t]*\n/);
  if (!m) return null;
  const fm = m[1].split("\n");
  const rest = text.slice(m[0].length);
  const h = rest.match(/^# (.*)$/m);
  const url = unquote((fm.find((l) => /^url:/.test(l)) || "url:").slice(4));
  let jobs = null;
  let hash = "";
  for (const l of fm) {
    const x = l.match(LINE);
    if (!x) continue;
    const words = x[1].split("·").map((w) => w.trim());
    jobs = Object.fromEntries(WORDS.map(([k, w]) => [k, words.includes(w)]));
    hash = x[2];
  }
  return {
    fm,
    pre: h ? rest.slice(0, h.index) : rest,
    title: h ? h[1].trim() : "",
    body: h ? rest.slice(h.index + h[0].length).replace(/^\n+/, "") : "",
    url,
    aliases: readAliases(fm),
    jobs,
    hash,
  };
}

/** frontmatter에 남길 결과 줄: Claude: "번역 확인 완료 · 2026-10-30 14:20 · 42줄 중 12줄 고침" */
export const statusLine = (text) => `${KEY}: ${JSON.stringify(text)}`;

/** 표시를 지우고(status가 있으면 그 결과 줄로 바꾸고) 별칭을 바꿔 노트를 다시 만든다 */
export function buildNote(note, { title, body, aliases, status }) {
  const fm = note.fm.filter((l) => (status ? !l.startsWith(`${KEY}:`) : !LINE.test(l)));
  if (status) fm.push(statusLine(status));
  if (aliases) {
    const lines = aliases.length ? ["aliases:", ...aliases.map((a) => `  - ${JSON.stringify(a)}`)] : [];
    const i = fm.findIndex((l) => /^aliases:/.test(l));
    if (i >= 0) {
      let j = i + 1;
      while (j < fm.length && /^[ \t]+-/.test(fm[j])) j++;
      fm.splice(i, j - i, ...lines);
    } else {
      // 별칭 줄이 없으면 url 바로 아래에 (기존 노트와 같은 자리)
      const u = fm.findIndex((l) => /^url:/.test(l));
      fm.splice(u + 1, 0, ...lines);
    }
  }
  return `---\n${fm.join("\n")}\n---\n${note.pre}# ${title}\n\n${body.replace(/^\n+/, "")}`;
}
