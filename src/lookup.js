// 고유명사·게임 용어의 한국 정식 명칭을 찾아 번역 용어집에 더한다. PC에서 Claude로 마무리할 때만 쓴다. 외국어 글 모두(일본어·영어 등)
// 1) Claude가 글에서 고유명사와 게임 속 용어(장소·던전·아이템·적·모드)를 원문 표기 그대로 뽑는다 (namesPrompt)
// 2) 위키백과 문서의 한국어판 제목 (언어 간 링크). 한자·가나 이름은 일본어판, 로마자 이름은 영어판에서 찾는다
// 3) Claude Code 웹 검색: 위키백과 표기가 글 맥락에 맞는지 확인하고, 없는 이름은 같은 게임의 원어 공식 누리집과
//    한국 공식 누리집(한국닌텐도 등)의 같은 부분을 비교해 한국 표기를 찾는다 (パドック → 대기소). 근거 주소가 있는 것만 받는다
// 찾은 표기는 용어집 노트의 "자동으로 찾은 표기" 칸에 남겨, 다음 글부터는 다시 찾지 않고 사용자가 고칠 수 있게 한다

export const AUTO_HEAD = "## 자동으로 찾은 표기";
const SEARCH_MAX = 25; // 웹 검색 한 번에 맡길 이름 수
const FAN_MAX = 30; // 팬 위키에서 찾아볼 이름 수
const CJK = /[぀-ヿ㐀-鿿]/;

/** 위키백과 응답에서 이름 → 한국어 문서 제목. "커비 (캐릭터)"처럼 붙은 구분 괄호는 뗀다 */
export function wikiKorean(json, names) {
  const q = json?.query || {};
  const next = Object.fromEntries([...(q.normalized || []), ...(q.redirects || [])].map((r) => [r.from, r.to]));
  const pages = Object.fromEntries((q.pages || []).map((p) => [p.title, p]));
  const out = new Map();
  for (const n of names) {
    let t = n;
    for (let i = 0; i < 5 && next[t]; i++) t = next[t];
    const ko = pages[t]?.langlinks?.[0]?.title;
    const clean = ko && ko.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (clean && /[가-힯]/.test(clean)) out.set(n, clean);
  }
  return out;
}

/** 위키백과 응답에서 이름 → 실제 문서 제목 (넘겨주기를 따라간 끝) */
export function wikiTargets(json, names) {
  const q = json?.query || {};
  const next = Object.fromEntries([...(q.normalized || []), ...(q.redirects || [])].map((r) => [r.from, r.to]));
  const out = new Map();
  for (const n of names) {
    let t = n;
    for (let i = 0; i < 5 && next[t]; i++) t = next[t];
    out.set(n, t);
  }
  return out;
}

/**
 * 원문이 시리즈 이름을 뺀 짧은 이름이면 문서 제목 앞의 시리즈 이름 (Ocarina of Time → "The Legend of Zelda: Ocarina of Time" → "The Legend of Zelda")
 * 한국어도 시리즈 이름을 빼고 써야 한다 (시간의 오카리나, 바람의 지휘봉)
 */
export function seriesOf(target, name) {
  if (!target || target === name) return "";
  const i = target.toLowerCase().lastIndexOf(name.toLowerCase().replace(/^the\s+/, ""));
  if (i <= 0) return "";
  const pre = target.slice(0, i);
  const s = (/[:：]/.test(pre) ? pre.split(/[:：]/)[0] : pre).trim();
  return s.length >= 2 && !name.toLowerCase().includes(s.toLowerCase()) ? s : "";
}

/** 한국어 제목에서 시리즈 이름을 뗀다. 떼고 남는 것이 없으면 그대로 */
export function stripSeries(ko, seriesKo) {
  if (!seriesKo || !ko.startsWith(seriesKo)) return ko;
  const rest = ko.slice(seriesKo.length).replace(/^[\s:：\-–]+/, "").trim();
  return rest && /[가-힯]/.test(rest) ? rest : ko;
}

/** 이름에 맞는 위키백과 (한자·가나 → 일본어판, 그 밖 → 영어판) */
export const wikiLang = (name) => (CJK.test(name) ? "ja" : "en");

export function wikiUrl(names, lang = "ja") {
  return `https://${lang}.wikipedia.org/w/api.php?` + new URLSearchParams({ action: "query", prop: "langlinks", lllang: "ko", redirects: "1", format: "json", formatversion: "2", titles: names.join("|") });
}

/** 이름 뽑기 지시문 */
export function namesPrompt(a) {
  return `아래 글에 나오는 이름 가운데 한국어로 옮길 때 정해진 표기가 있을 만한 것을 원문 표기 그대로 뽑는다.
- 대상: 게임·작품·회사·인물·캐릭터·지명의 이름, 그리고 게임 속 용어(장소·던전·아이템·적·기술·모드·메뉴 이름)
- 보통 낱말, 일반 개념(예: open world, frame rate), 매체·기자 이름은 넣지 않는다
- 한 줄에 하나, 원문 표기만 쓴다. 번역이나 설명은 쓰지 않는다. 없으면 "없음"만 쓴다
- 원문 표기가 영어가 아니면(일본어 등) 영어판 공식 이름을 알 때만 "원문 표기 | 영어판 이름"으로 쓴다 (예: 時のオカリナ | Ocarina of Time)

<글>
# ${a.title}

${a.markdown}
</글>
`;
}

const nameLines = (out) =>
  String(out || "")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").replace(/\s*→.*$/, "").trim())
    .filter((l) => l && !/^없음/.test(l));

export function parseNames(out) {
  return [...new Set(nameLines(out).map((l) => l.split("|")[0].trim()).filter((l) => l && l.length <= 60))];
}

/** 일본어 등 원문 이름 → 영어판 이름 (팬 위키 문서 제목을 찾는 데 쓴다) */
export function parseEnglish(out) {
  const m = new Map();
  for (const l of nameLines(out)) {
    const [a, b] = l.split("|").map((x) => x.trim());
    if (a && b && /^[\x20-\x7e]+$/.test(b)) m.set(a, b);
  }
  return m;
}

// ---------- 팬 위키: 게임 팬 위키 문서의 "다른 언어 이름" 표에 한국어판 이름이 있다 (Bombchu → 찍폭탄, Paddock → 대기소) ----------

export const FAN_WIKIS = [
  { re: /zelda|hyrule|ゼルダ|ハイラル/i, name: "Zelda Wiki", api: "https://zeldawiki.wiki/w/api.php" },
  { re: /kirby|カービィ/i, name: "WiKirby", api: "https://wikirby.com/w/api.php" },
  { re: /pok[eé]mon|ポケモン|ポケットモンスター/i, name: "Bulbapedia", api: "https://bulbapedia.bulbagarden.net/w/api.php" },
  { re: /mario|luigi|yoshi|donkey kong|マリオ|ルイージ|ヨッシー|ドンキーコング/i, name: "Super Mario Wiki", api: "https://www.mariowiki.com/api.php" },
  { re: /splatoon|スプラトゥーン/i, name: "Inkipedia", api: "https://splatoonwiki.org/w/api.php" },
  { re: /xenoblade|ゼノブレイド/i, name: "Xeno Series Wiki", api: "https://www.xenoserieswiki.org/w/api.php" },
  { re: /metroid|samus|メトロイド/i, name: "Metroid Wiki", api: "https://www.metroidwiki.org/w/api.php" },
  { re: /fire emblem|ファイアーエムブレム/i, name: "Fire Emblem Wiki", api: "https://fireemblemwiki.org/w/api.php" },
  { re: /smash bros|大乱闘|スマブラ/i, name: "SmashWiki", api: "https://www.ssbwiki.com/api.php" },
];

/**
 * 글에 맞는 팬 위키: 시리즈 이름이 가장 많이 나오는 하나만.
 * 둘째 위키까지 보면 같은 이름의 다른 게임 물건을 가져온다 (젤다 글의 Iron Boots → 마리오 위키의 아이언점프)
 */
export function fanWikisFor(text) {
  return FAN_WIKIS.map((w) => [w, (String(text).match(new RegExp(w.re.source, "gi")) || []).length])
    .filter(([, n]) => n)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 1)
    .map(([w]) => w);
}

export const fanUrl = (api, page) => `${api}?` + new URLSearchParams({ action: "parse", page, prop: "text", format: "json", formatversion: "2", redirects: "1" });

/** 팬 위키 문서에서 한글이 있는 줄과 그 앞 두 줄 (언어 이름 표의 "Korea" 칸) */
export function fanSnippets(text, max = 12) {
  const lines = String(text || "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    if (!/[가-힯]/.test(lines[i])) continue;
    out.push(lines.slice(Math.max(0, i - 2), i + 1).join(" / ").replace(/\s+/g, " ").slice(0, 200));
  }
  return out;
}

export function fanPrompt(items) {
  return `아래는 게임 팬 위키 문서에서 한글이 나오는 부분이다. 대부분 "다른 언어 이름" 표의 한국어판(Korea) 칸이다.
이름마다 한국어판 게임에서 쓰는 공식 이름을 고른다.
- 한 줄에 "원어 → 한국어판 이름"
- 보여 준 글자 그대로 쓴다. 한국어판 이름으로 볼 수 없으면(설명 문장, 다른 대상의 이름) "원어 → 없음"
- 설명은 덧붙이지 않는다

${items.map(([name, page, lines]) => `[${name}] (${page})\n${lines.join("\n")}`).join("\n\n")}
`;
}

/** 팬 위키 결과: 보여 준 부분에 실제로 있는 표기만 */
export function parseFan(out, items) {
  const by = new Map(items.map(([name, , lines]) => [name, lines.join("\n")]));
  const found = new Map();
  for (const raw of String(out || "").split("\n")) {
    const m = raw.replace(/^\s*[-*]\s*/, "").match(/^(.+?)\s*→\s*([^|]+?)\s*(?:\|.*)?$/);
    if (!m || !by.has(m[1].trim())) continue;
    const to = m[2].replace(/\*\*/g, "").trim();
    if (!to || /^없음/.test(to) || !/[가-힯]/.test(to) || to.length > 40 || !by.get(m[1].trim()).includes(to)) continue;
    found.set(m[1].trim(), to);
  }
  return found;
}

/** 확인·검색 지시문. wiki: 위키백과로 찾은 후보(맥락이 맞는지 확인), rest: 웹 검색으로 찾을 이름 */
export function searchPrompt(title, wiki, rest) {
  const a = wiki.length
    ? `A. 위키백과 한국어판 문서 제목으로 찾은 후보다. 이름마다 먼저 이 글에서 무엇을 가리키는지 정한다.
- 게임·작품·회사·인물·실제 지명처럼 위키백과에 자기 문서가 있을 대상이고, 후보 문서가 바로 그 대상이면 "원어 → 표기 | 위키백과"로 그대로 쓴다
- 게임 속 용어(게임 안의 장소·아이템·적·캐릭터·기술·모드·메뉴)이면 위키백과 후보는 쓰지 않는다. 같은 낱말의 일반 뜻 문서(예: パドック → 예시장)일 수 있기 때문이다. 아래 B와 같은 방법으로 공식 누리집을 비교해 찾는다
- 다른 대상의 문서이거나 공식 표기를 못 찾으면 "원어 → 없음"으로 쓴다
${wiki.map(([f, t]) => `${f} → ${t}`).join("\n")}

`
    : "";
  const b = rest.length
    ? `${wiki.length ? "B. " : ""}아래 이름의 한국 정식 표기를 웹 검색으로 찾는다.
- 정식 표기는 한국에 공식으로 발매·발표된 표기다. 게임이면 그 게임의 한국어판 공식 누리집(한국닌텐도 nintendo.com/kr 등), 한국어판 설명서·소개 영상, 한국 공식 발표를 근거로 한다
- 게임 속 용어(장소·아이템·적·모드)는 같은 게임의 원어 공식 누리집(일본·미국)과 한국 공식 누리집에서 같은 내용을 설명하는 부분을 찾아 비교한다. 예: 일본 누리집에서 パドック를 설명하는 문장이 한국 누리집에서는 대기소로 쓰여 있으면 パドック → 대기소
- 같은 게임의 이전 한국어판(예: 3DS판)에서 쓴 표기도 근거가 된다
- 공식 자료에서 못 찾으면 팬 위키(나무위키, Zelda Wiki·WiKirby·Bulbapedia 같은 게임 팬 위키의 다른 언어 이름 표)에 적힌 한국어판 표기도 근거가 된다
- 원문이 시리즈 이름을 뺀 짧은 이름이면 한국어도 짧은 이름으로 쓴다 (Ocarina of Time → 시간의 오카리나, Wind Waker → 바람의 지휘봉)
- 찾으면 "원어 → 한국 정식 표기 | 근거 주소", 근거 주소에서 확인하지 못했으면 "원어 → 없음". 추측하거나 발음대로 옮기지 않는다
${rest.join("\n")}

`
    : "";
  return `글 제목: ${title}

이 글에 나오는 이름의 한국 정식 표기를 정한다.

${a}${b}한 줄에 하나씩 "원어 → 표기 | 근거" 형식으로만 쓰고 설명은 덧붙이지 않는다.
글이 다루는 게임의 공식 누리집을 찾았으면 맨 끝에 "공식 누리집: 원어판 주소 | 한국판 주소" 한 줄을 쓴다(원어판은 nintendo.com/jp·nintendo.co.jp·nintendo.com/us 등, 한국판은 nintendo.com/kr 등, 게임 소개 첫 페이지). 게임이 여럿이면 줄을 여럿 쓴다.
`;
}

/** 나무위키 검색 지시문 (앞 단계에서 못 찾은 이름만) */
export function namuPrompt(title, names) {
  return `글 제목: ${title}

이 글이 다루는 게임·작품에 나오는 아래 이름의 한국어판 표기를 나무위키에서 찾는다. 웹 검색으로 "나무위키 <게임 이름> <이름>"이나 namu.wiki의 그 게임 문서(등장인물·몬스터·던전·아이템·지역 문서)를 찾아, 문서에 적힌 한국어판 이름을 쓴다.
- 한 줄에 "원어 → 한국어판 표기 | 근거 주소"
- 원문이 시리즈 이름을 뺀 짧은 이름이면 한국어도 짧은 이름으로 쓴다
- 한국어판 표기를 확인하지 못하면 "원어 → 없음". 추측하거나 발음대로 옮기지 않는다
${names.join("\n")}
`;
}

/** "공식 누리집: 원어판 | 한국판" 줄 */
export function parseSites(out) {
  const sites = [];
  for (const raw of String(out || "").split("\n")) {
    const m = raw.match(/공식 누리집\s*[:：]\s*(https?:\/\/\S+?)\s*\|\s*(https?:\/\/\S+?)\s*$/);
    if (m) sites.push({ src: m[1], ko: m[2] });
  }
  return sites.slice(0, 3);
}

/** 원어판 누리집에서 이름이 나오는 문장들 (앞뒤 조금) */
export function snippets(text, name, max = 4) {
  const out = [];
  let i = text.indexOf(name);
  while (i >= 0 && out.length < max) {
    out.push(text.slice(Math.max(0, i - 120), i + name.length + 120).replace(/\s+/g, " ").trim());
    i = text.indexOf(name, i + name.length);
  }
  return out;
}

/** 두 누리집 비교 지시문 */
export function comparePrompt(items, koText) {
  return `같은 게임의 원어판 공식 누리집과 한국판 공식 누리집이다. <원어판>에는 이름마다 그 이름이 나오는 부분을 보여 준다.
<한국판>에서 같은 내용을 설명하는 부분을 찾아, 그 이름을 한국판에서 어떻게 쓰는지 찾는다.
- 한 줄에 "원어 → 한국판 표기 | 한국판에서 그 표기가 나오는 문장 일부"
- 한국판 표기는 <한국판>에 있는 글자 그대로 쓴다. 한국판에서 같은 부분을 찾지 못하면 "원어 → 없음"
- 설명은 덧붙이지 않는다

<원어판>
${items.map(([name, ctx]) => `[${name}]\n${ctx.map((c) => `… ${c} …`).join("\n")}`).join("\n\n")}
</원어판>

<한국판>
${koText}
</한국판>
`;
}

/** 비교 결과: 한국판 누리집에 실제로 있는 표기만 받는다 */
export function parseCompare(out, names, koText) {
  const want = new Set(names);
  const found = new Map();
  for (const raw of String(out || "").split("\n")) {
    const m = raw.replace(/^\s*[-*]\s*/, "").match(/^(.+?)\s*→\s*([^|]+?)\s*(?:\|.*)?$/);
    if (!m || !want.has(m[1].trim())) continue;
    const to = m[2].replace(/\*\*/g, "").trim();
    if (!to || /^없음/.test(to) || !/[가-힯]/.test(to) || to.length > 40 || !koText.includes(to)) continue;
    found.set(m[1].trim(), to);
  }
  return found;
}

const KO_MAX = 30000; // 한국판 누리집 본문을 넘길 최대 글자 수

/** HTML → 글자만 (스크립트·스타일 빼고, 태그 자리는 줄바꿈). 이미지 대체 글도 남긴다 */
export function htmlText(html) {
  const ent = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(html || "")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ent[e.toLowerCase()] ?? m))
    .replace(/[ \t\r]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** "원어 → 표기 | 주소" 줄을 읽는다 (표 모양으로 와도 받는다). 근거가 있는 것만 */
export function parseSearch(out, names) {
  const want = new Set(names);
  const found = new Map();
  for (const raw of String(out || "").split("\n")) {
    const line = raw.replace(/^\s*[|*-]\s*/, "").trim();
    // 근거 뒤에 "(…)" 같은 말을 덧붙여 와도 받는다
    const m = line.match(/^(.+?)\s*→\s*(.+?)\s*\|\s*(https?:\/\/[^\s|]+|위키백과)(?:\s.*)?\|?\s*$/);
    if (!m || !want.has(m[1].trim())) continue;
    const to = m[2].replace(/\*\*/g, "").trim();
    if (!to || /^없음/.test(to) || !/[가-힯]/.test(to) || to.length > 60) continue;
    found.set(m[1].trim(), { to, url: m[3] });
  }
  return found;
}

/** 용어집 노트의 자동 칸에 새 표기를 더한다 (이미 있는 원어는 건너뛴다). 칸이 없으면 끝에 만든다 */
export function addAuto(text, entries) {
  text = String(text || "").replace(/\r\n/g, "\n");
  const have = new Set([...text.matchAll(/^\s*[-*]\s+(.+?)\s*(?:→|->|=)/gm)].map((m) => m[1].trim()));
  const lines = entries.filter((e) => !have.has(e.from)).map((e) => `- ${e.from} → ${e.to} %% ${e.source} %%`);
  if (!lines.length) return text;
  if (!text.includes(AUTO_HEAD)) text = `${text.trimEnd()}\n\n${AUTO_HEAD}\n\n위키백과·웹 검색으로 찾은 한국 정식 명칭. 틀렸으면 고치거나 지운다. 위쪽에 직접 적은 표기가 먼저다.\n`;
  return `${text.trimEnd()}\n${lines.join("\n")}\n`;
}

/**
 * 이름들의 한국 정식 표기를 찾는다
 * @param {string[]} names  글에서 뽑은 원어 이름 (용어집에 이미 있는 것은 빼고 넘긴다)
 * @param {{getJson:(url:string)=>Promise<any>, search?:(prompt:string)=>Promise<string>, title?:string}} deps
 * @returns {Promise<{from:string, to:string, source:string}[]>}
 */
export async function findKorean(names, { getJson, search, compare, getText, title = "", english = new Map(), fan = [] }) {
  const all = [...new Set(names)].filter(Boolean);
  const wiki = new Map();
  for (const lang of ["ja", "en"]) {
    const mine = all.filter((n) => wikiLang(n) === lang);
    const series = new Map(); // 이름 → 시리즈 이름 (짧은 이름으로 쓴 경우)
    for (let i = 0; i < mine.length; i += 50) {
      const part = mine.slice(i, i + 50);
      try {
        const json = await getJson(wikiUrl(part, lang));
        for (const [from, to] of wikiKorean(json, part)) wiki.set(from, to);
        for (const [from, t] of wikiTargets(json, part)) {
          const s = seriesOf(t, from);
          if (s && wiki.has(from)) series.set(from, s);
        }
      } catch (e) {
        // 위키백과가 안 되면 웹 검색으로 넘긴다
      }
    }
    // 짧은 이름이면 한국어 제목에서도 시리즈 이름을 뗀다 (젤다의 전설 바람의 지휘봉 → 바람의 지휘봉)
    const sNames = [...new Set(series.values())];
    if (sNames.length) {
      try {
        const sKo = wikiKorean(await getJson(wikiUrl(sNames.slice(0, 50), lang)), sNames);
        for (const [from, s] of series) wiki.set(from, stripSeries(wiki.get(from), sKo.get(s)));
      } catch (e) {
        // 시리즈 이름을 못 찾으면 그대로 둔다 (Claude 확인에서 짧게 고칠 수 있다)
      }
    }
  }
  // 위키백과는 같은 이름의 다른 대상·일반 낱말(パドック → 예시장)도 잡으므로, Claude가 글 맥락으로 확인한 것만 쓴다.
  // 확인할 수 없으면(검색 실패) 아무것도 더하지 않는다 — 틀린 표기를 용어집에 남기는 것보다 낫다
  if (!search) return [];
  const rest = all.filter((n) => !wiki.has(n)).slice(0, SEARCH_MAX);
  let out;
  try {
    out = await search(searchPrompt(title, [...wiki], rest));
  } catch (e) {
    return [];
  }
  const found = [];
  // 검색이 답한 이름 가운데 못 찾은 것 (다음 글에서 같은 이름을 곧바로 다시 검색하지 않도록 플러그인이 기억한다)
  found.missed = [];
  for (const [from, v] of parseSearch(out, [...wiki.keys(), ...rest])) {
    if (v.url === "위키백과") {
      if (wiki.get(from) === v.to) found.push({ from, to: v.to, source: "위키백과" });
    } else found.push({ from, to: v.to, source: `웹 검색 ${v.url}` });
  }
  // 아직 못 찾은 이름은 원어판·한국판 공식 누리집을 직접 받아 같은 부분을 맞대 본다
  // (검색 도구는 페이지를 요약해 읽어 게임 속 용어를 놓친다: パドック → 대기소)
  if (compare && getText) {
    for (const site of parseSites(out)) {
      const left = all.filter((n) => !found.some((f) => f.from === n));
      if (!left.length) break;
      try {
        const [src, ko] = await Promise.all([getText(site.src), getText(site.ko)]);
        const items = left.map((n) => [n, snippets(src, n)]).filter(([, c]) => c.length);
        if (!items.length || !/[가-힯]/.test(ko)) continue;
        const koText = ko.slice(0, KO_MAX);
        for (const [from, to] of parseCompare(await compare(comparePrompt(items, koText)), items.map(([n]) => n), koText)) {
          found.push({ from, to, source: `공식 누리집 비교 ${site.ko}` });
        }
      } catch (e) {
        // 누리집을 못 받으면 건너뛴다
      }
    }
  }
  // 그래도 못 찾은 이름은 게임 팬 위키 문서의 다른 언어 이름 표에서 한국어판 이름을 찾는다
  if (compare && fan.length) {
    const left = all.filter((n) => !found.some((f) => f.from === n)).slice(0, FAN_MAX);
    const items = [];
    await Promise.all(
      left.map(async (n) => {
        const page = english.get(n) || (/^[\x20-\x7e]+$/.test(n) ? n : "");
        if (!page) return;
        for (const w of fan) {
          try {
            const j = await getJson(fanUrl(w.api, page));
            const lines = fanSnippets(htmlText(j?.parse?.text || ""));
            if (lines.length) return items.push([n, `${w.name}: ${j.parse.title || page}`, lines, w]);
          } catch (e) {
            // 문서가 없으면 다음 위키
          }
        }
      })
    );
    if (items.length) {
      try {
        for (const [from, to] of parseFan(await compare(fanPrompt(items)), items)) {
          const it = items.find((x) => x[0] === from);
          found.push({ from, to, source: `팬 위키 ${it[3].name} ${it[3].api.replace(/\/(w\/)?api\.php$/, "")}/wiki/${encodeURIComponent((english.get(from) || from).replace(/ /g, "_"))}` });
        }
      } catch (e) {
        // 실패하면 건너뛴다
      }
    }
  }
  // 마지막으로 나무위키: 한국어판 게임 문서(등장인물·몬스터·던전 문서)에 표기가 정리되어 있다. 이름만 좁혀 따로 검색해야 찾는다
  const left = all.filter((n) => !found.some((f) => f.from === n)).slice(0, SEARCH_MAX);
  if (left.length) {
    try {
      for (const [from, v] of parseSearch(await search(namuPrompt(title, left)), left)) {
        if (v.url !== "위키백과") found.push({ from, to: v.to, source: `${/namu\.wiki/.test(v.url) ? "나무위키" : "웹 검색"} ${v.url}` });
      }
    } catch (e) {
      // 실패하면 건너뛴다
    }
  }
  found.missed = [...wiki.keys(), ...rest].filter((n) => !found.some((f) => f.from === n));
  return found;
}

// ---------- 이미 만든 노트의 표기 맞추기 ----------

// 받침 있는지 (한글 음절만. 숫자·영문으로 끝나면 판단하지 않는다)
const batchim = (ch) => {
  const c = ch.charCodeAt(0) - 0xac00;
  return c >= 0 && c < 11172 ? c % 28 : -1; // -1: 한글 아님, 0: 받침 없음, 8: ㄹ받침
};
const PARTICLES = [
  ["을", "를"],
  ["이", "가"],
  ["은", "는"],
  ["과", "와"],
  ["이랑", "랑"],
  ["으로", "로"],
];

/** 표기를 바꾸고 바로 뒤 조사를 새 표기의 받침에 맞춘다 (봄츄를 → 찍폭탄을) */
export function replaceName(s, from, to) {
  const b = batchim(to.slice(-1));
  return s.split(from).reduce((acc, part, i) => {
    if (i === 0) return part;
    let p = part;
    if (b >= 0) {
      for (const [withB, noB] of PARTICLES) {
        const m = p.match(new RegExp(`^(${withB}|${noB})(?![가-힯])`)) || (withB === "으로" ? p.match(/^(으로|로)/) : null);
        if (!m) continue;
        const want = withB === "으로" ? (b === 0 || b === 8 ? noB : withB) : b ? withB : noB;
        p = want + p.slice(m[1].length);
        break;
      }
    }
    return acc + to + p;
  }, "");
}

/** 노트에서 정식 표기와 다르게 쓴 곳을 찾는 지시문 */
export function fixPrompt(noteBody, terms) {
  return `아래는 외국어 글을 한국어로 옮긴 노트이고, <표기>는 원어 → 한국 정식 표기 목록이다.
노트에서 <표기>의 대상을 정식 표기와 다르게 쓴 곳을 찾아, 노트에 쓰인 그대로의 표기와 정식 표기를 짝지어 쓴다.
- 한 줄에 "노트의 표기 → 정식 표기"
- 노트의 표기는 노트에 있는 글자 그대로 쓴다(조사는 빼고 이름만). 이미 정식 표기면 쓰지 않는다
- <표기>에 없는 대상은 고치지 않는다. 고칠 것이 없으면 "없음"만 쓴다
- 같은 대상의 긴 이름(시리즈 이름 포함)과 짧은 이름이 둘 다 <표기>에 있으면 어느 쪽이든 정식이다. 그런 곳은 고치지 않는다

<표기>
${terms.map(([f, t]) => `${f} → ${t}`).join("\n")}
</표기>

<노트>
${noteBody}
</노트>
`;
}

/** "노트의 표기 → 정식 표기" 줄을 읽는다. 노트에 실제로 있는 표기만 */
export function parseFixPairs(out, noteBody, terms) {
  const official = new Set(terms.map(([, t]) => t));
  const pairs = [];
  for (const raw of String(out || "").split("\n")) {
    const m = raw.replace(/^\s*[-*]\s*/, "").match(/^(.+?)\s*→\s*(.+?)\s*$/);
    if (!m) continue;
    const [from, to] = [m[1].trim(), m[2].trim()];
    if (from === to || !official.has(to) || !noteBody.includes(from) || from.length < 2) continue;
    pairs.push([from, to]);
  }
  return pairs.sort((x, y) => y[0].length - x[0].length);
}
