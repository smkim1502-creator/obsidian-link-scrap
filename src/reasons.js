// 탭 보내기: 탭을 닫기 전에 "왜 켜 뒀는지"를 고르면, 이유마다 노트 하나에 한 줄씩 쌓는다.
// 이유 목록은 사용자가 설정이나 창에서 늘리고 줄인다 (정해진 몇 가지가 아니다)

// scrap: "" 링크만 · "original" 본문도 저장 · "translate" 본문도 저장하고 외국어는 한국어로
export const SCRAP_KINDS = [
  ["", "링크만"],
  ["original", "본문도 저장 (원문)"],
  ["translate", "본문도 저장 (외국어는 한국어 번역)"],
];

export const DEFAULT_REASONS = [
  { name: "해 보고 싶은 것", scrap: "" },
  { name: "읽을거리", scrap: "translate" },
  { name: "볼거리", scrap: "" },
  { name: "생각 재료", scrap: "" },
  { name: "만들고 싶은 것", scrap: "" },
  { name: "사고 싶은 것", scrap: "" },
];

export const copyReasons = (list) => list.map((r) => ({ name: r.name, scrap: r.scrap || "" }));

/** 구글 검색 결과는 페이지를 받지 않고 검색어로 제목을 만든다 */
export function searchTitle(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname) || u.pathname !== "/search") return "";
    const q = (u.searchParams.get("q") || "").trim();
    if (!q) return "";
    return u.searchParams.get("udm") === "vids" ? `구글 동영상 검색: ${q}` : `구글 검색: ${q}`;
  } catch {
    return "";
  }
}

/** 제목을 못 얻었을 때: 사이트 이름과 주소 끝부분 */
export function fallbackTitle(url) {
  try {
    const u = new URL(url);
    const tail = decodeURIComponent(u.pathname).replace(/\/+$/, "").split("/").pop();
    return tail ? `${u.hostname} · ${tail}` : u.hostname;
  } catch {
    return url;
  }
}

// [제목](주소)의 제목 칸에서 링크를 깨뜨리는 글자를 바꾼다
const linkText = (t) => t.replace(/\s+/g, " ").replace(/\[/g, "〔").replace(/\]/g, "〕").replace(/\|/g, "·").trim();
// 주소 속 괄호·공백은 링크를 끊으므로 인코딩한다
const linkUrl = (u) => u.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");

/** 설명 칸 정리: 줄바꿈은 띄어쓰기로, 링크 주소만 붙여 넣은 경우는 설명이 아니므로 비운다 */
export function cleanDesc(desc, url = "") {
  let d = (desc || "").replace(/\s+/g, " ").trim();
  if (url) d = d.split(url).join(" ").replace(/\s+/g, " ").trim();
  if (/^https?:\/\/\S+$/i.test(d)) return "";
  return d.replace(/^[-—·:|\s]+|[-—·:|\s]+$/g, "");
}

/**
 * 이유 노트에 넣을 항목 (두 줄). 할 일처럼 체크할 수 있게 체크박스로 시작한다.
 * 첫 줄: 설명(있으면) 또는 링크 — 무엇인지가 먼저 보이게
 * 둘째 줄(들여쓰기): 스크랩한 날짜와 링크
 * note가 있으면(본문도 저장한 경우) 그 노트를 먼저 링크한다
 */
export function tabLine({ title, url, note = "", why = "", date }) {
  const head = note ? `[[${note}]] · [원문](${linkUrl(url)})` : `[${linkText(title) || url}](${linkUrl(url)})`;
  const desc = cleanDesc(why, url);
  return desc ? `- [ ] ${desc}\n\t- ${date} 스크랩 · ${head}` : `- [ ] ${head}\n\t- ${date} 스크랩`;
}

/** 이유 노트에 항목 하나를 더한다. 같은 주소가 이미 있으면 null */
export function addTabLine(text, name, line, url) {
  if (text && text.includes(`(${linkUrl(url)})`)) return null;
  if (!text || !text.trim()) return `# ${name}\n\n${line}\n`;
  return `${text.replace(/\s+$/, "")}\n${line}\n`;
}
