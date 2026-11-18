// 고유명사(게임·캐릭터·회사·인물)의 한국 정식 명칭을 찾아 번역 용어집에 더한다. PC에서 Claude로 마무리할 때만 쓴다.
// 1) Claude가 글에서 한자·가나 고유명사를 뽑는다 (claudeGlossary)
// 2) 일본어 위키백과 문서의 한국어판 제목 (언어 간 링크) — 사람이 정해 둔 표기라 가장 믿을 만하다
// 3) 위키백과에 없으면 Claude Code 웹 검색으로 한국 공식 표기(한국닌텐도 등)를 근거 주소와 함께 찾는다
// 찾은 표기는 용어집 노트의 "자동으로 찾은 표기" 칸에 남겨, 다음 글부터는 다시 찾지 않고 사용자가 고칠 수 있게 한다

export const AUTO_HEAD = "## 자동으로 찾은 표기";
const WIKI = "https://ja.wikipedia.org/w/api.php?";
const SEARCH_MAX = 15; // 웹 검색 한 번에 맡길 이름 수

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

export function wikiUrl(names) {
  return WIKI + new URLSearchParams({ action: "query", prop: "langlinks", lllang: "ko", redirects: "1", format: "json", formatversion: "2", titles: names.join("|") });
}

/** 확인·검색 지시문. wiki: 위키백과로 찾은 후보(맥락이 맞는지 확인만), rest: 웹 검색으로 찾을 이름 */
export function searchPrompt(title, wiki, rest) {
  const a = wiki.length
    ? `A. 위키백과 한국어판 문서 제목으로 찾은 표기다. 이 글에서 그 이름이 가리키는 대상과 같은 대상의 문서인지 확인한다. 같으면 "원어 → 표기 | 위키백과"로 그대로 쓰고, 다른 대상(같은 이름의 다른 것, 일반 낱말)이면 "원어 → 없음"으로 쓴다.
${wiki.map(([f, t]) => `${f} → ${t}`).join("\n")}

`
    : "";
  const b = rest.length
    ? `${wiki.length ? "B. " : ""}아래 이름의 한국 정식 명칭을 웹 검색으로 찾는다. 정식 명칭은 한국에 공식으로 발매·발표된 표기(예: 한국닌텐도 누리집, 한국어판 게임 정보)이다. 찾으면 "원어 → 한국 정식 명칭 | 근거 주소", 근거 주소에서 확인하지 못했으면 "원어 → 없음"으로 쓴다. 추측하거나 발음대로 옮기지 않는다.
${rest.join("\n")}

`
    : "";
  return `글 제목: ${title}

이 글에 나오는 고유명사(게임·캐릭터·회사·인물·지명)의 한국 정식 명칭을 정한다.

${a}${b}한 줄에 하나씩 "원어 → 표기 | 근거" 형식으로만 쓰고 설명은 덧붙이지 않는다.
`;
}

/** "원어 → 표기 | 주소" 줄을 읽는다 (표 모양으로 와도 받는다). 근거 주소가 있는 것만 */
export function parseSearch(out, names) {
  const want = new Set(names);
  const found = new Map();
  for (const raw of String(out || "").split("\n")) {
    const line = raw.replace(/^\s*[|*-]\s*/, "").trim();
    const m = line.match(/^(.+?)\s*→\s*(.+?)\s*\|\s*(https?:\/\/\S+?|위키백과)\s*\|?\s*$/);
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
 * 글의 고유명사를 뽑아 한국 정식 명칭을 찾는다
 * @param {string[]} names  글에서 뽑은 원어 이름 (용어집에 이미 있는 것은 빼고 넘긴다)
 * @param {{getJson:(url:string)=>Promise<any>, search?:(prompt:string)=>Promise<string>}} deps
 * @returns {Promise<{from:string, to:string, source:string}[]>}
 */
export async function findKorean(names, { getJson, search, title = "" }) {
  const all = [...new Set(names)].filter(Boolean);
  const wiki = new Map();
  for (let i = 0; i < all.length; i += 50) {
    const part = all.slice(i, i + 50);
    try {
      for (const [from, to] of wikiKorean(await getJson(wikiUrl(part)), part)) wiki.set(from, to);
    } catch (e) {
      // 위키백과가 안 되면 웹 검색으로 넘긴다
    }
  }
  // 위키백과는 같은 이름의 다른 대상·일반 낱말(パドック → 예시장)도 잡으므로, Claude가 글 맥락으로 확인한 것만 쓴다.
  // 확인할 수 없으면(검색 실패) 아무것도 더하지 않는다 — 틀린 표기를 용어집에 남기는 것보다 낫다
  if (!search) return [];
  const rest = all.filter((n) => !wiki.has(n)).slice(0, SEARCH_MAX);
  let got;
  try {
    got = parseSearch(await search(searchPrompt(title, [...wiki], rest)), [...wiki.keys(), ...rest]);
  } catch (e) {
    return [];
  }
  const found = [];
  for (const [from, v] of got) {
    if (v.url === "위키백과") {
      if (wiki.get(from) === v.to) found.push({ from, to: v.to, source: "위키백과" });
    } else found.push({ from, to: v.to, source: `웹 검색 ${v.url}` });
  }
  return found;
}
