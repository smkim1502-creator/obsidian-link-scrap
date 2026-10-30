// Claude 확인 기록: 스크랩 노트마다 Claude가 언제, 무엇을, 얼마나 고쳤는지 한 노트에 모은다.
// PC가 쓰고 동기화로 휴대폰에서도 본다. 맨 위에는 아직 확인 대기인 노트, 그 아래 기록(최신이 위).

export const LOG_NAME = "Claude 확인 기록";
const PENDING_HEAD = "## 아직 확인 대기";
const LOG_HEAD = "## 기록";
const MAX_ENTRIES = 100;
const MAX_CHANGES = 60; // 한 노트에서 보여 줄 고친 줄 수

const pad = (n) => String(n).padStart(2, "0");
export const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 무슨 일을 했는지: "번역 확인", "번역·요약", "요약", "별칭 확인" */
export function jobName(jobs) {
  if (jobs.summary) return jobs.translate ? "번역·요약" : "요약";
  if (jobs.translate) return "번역 확인";
  return "별칭 확인";
}

/**
 * 마무리 결과 한 줄 (노트 frontmatter와 기록에 같이 쓴다)
 * @param {{translate?:boolean, summary?:boolean, alias?:boolean}} jobs
 * @param {{fixes?:number, total?:number, parts?:number, answered?:number}} r
 */
export function doneText(jobs, r = {}, when = stamp()) {
  const missing = (r.parts || 0) - (r.answered || 0);
  const head = missing > 0 ? `${jobName(jobs)} 일부만 완료` : `${jobName(jobs)} 완료`;
  const detail = !jobs.summary && jobs.translate && r.total ? `${r.total}줄 중 ${r.fixes}줄 고침` : "";
  return [head, when, detail].filter(Boolean).join(" · ");
}

// 줄 앞 마크다운 기호(#, -, >, 1.)는 인용 상자 안에서 모양을 깨뜨리므로 빼고 보여 준다
const plain = (line) => line.replace(/^\s*((?:[-*+]|\d+[.)]|#{1,6}|>)\s+)*/, "");
const quote = (lines) => lines.map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");

/**
 * 기록 한 칸
 * @param {object} o
 * @param {string} o.when  stamp()
 * @param {string} o.link  [[노트]]
 * @param {"done"|"skip"|"fail"|"later"} o.kind  완료 / 노트를 고쳐서 건너뜀 / Claude가 거절·쓸 수 없는 결과 / 실행 실패(다시 시도)
 * @param {object} o.jobs
 * @param {string} [o.source]  "휴대폰 초안" 처럼 어디서 온 초안인지
 * @param {object} [o.r]  finishDraft 결과 (changes, skipped, parts, answered, fixes, total)
 * @param {string} [o.draft]  요약을 바꾸기 전 초안 본문
 * @param {{before:string[], after:string[]}} [o.alias]
 * @param {string} [o.reason]
 */
export function formatEntry(o) {
  const out = [`### ${o.when} · ${o.link}`];
  const notes = [];
  const job = jobName(o.jobs);
  if (o.kind === "done") {
    const r = o.r || {};
    out.push([doneText(o.jobs, r, ""), o.source].filter(Boolean).join(" · "));
    const missing = (r.parts || 0) - (r.answered || 0);
    if (missing > 0) notes.push(`글이 길어 ${r.parts}부분으로 나눠 확인했는데 ${missing}부분은 Claude가 확인하지 않아 구글 번역 그대로다`);
    if (r.skipped) notes.push(`Claude가 고친 ${r.skipped}줄은 내용이 빠지거나 링크가 사라져 받지 않고 구글 번역 그대로 두었다`);
    if (o.alias) notes.push(`별칭: ${o.alias.before.join(", ") || "없음"} → ${o.alias.after.join(", ") || "없음"}`);
    if (!o.jobs.summary && o.jobs.translate && r.changes && !r.changes.length) notes.push("고칠 줄이 없어 구글 번역 그대로가 최종본이다");
    out.push(...notes.map((n) => `- ${n}`));
    if (r.changes?.length) {
      const shown = r.changes.slice(0, MAX_CHANGES);
      const lines = [`[!example]- 고친 줄 ${r.changes.length}개 (위: 구글 번역, 아래: Claude)`];
      for (const c of shown) lines.push("", `~~${plain(c.before).replace(/~~/g, "")}~~`, plain(c.after));
      if (r.changes.length > shown.length) lines.push("", `… 나머지 ${r.changes.length - shown.length}줄은 노트에서 확인`);
      out.push("", quote(lines));
    }
    if (o.draft && o.jobs.summary) {
      out.push("", quote(["[!example]- 바꾸기 전 초안 (핵심 문장 고르기)", "", ...o.draft.trim().split("\n")]));
    }
  } else if (o.kind === "skip") {
    out.push(`${job} 건너뜀 · 초안을 만든 뒤 노트를 고친 흔적이 있어 그대로 둠`);
    out.push("- PC에서 노트를 열고 명령 '이 노트 Claude로 마무리'를 실행하면 Claude 결과로 바뀐다 (고친 내용은 사라진다)");
  } else if (o.kind === "fail") {
    out.push(`${job} 못 함 · ${o.reason}`);
    out.push("- 초안 그대로가 최종본이다");
  } else {
    out.push(`${job} 미룸 · ${o.reason}`);
    out.push("- 확인 대기 표시는 그대로 두었다. 다음에 PC 옵시디언을 켜면 다시 한다");
  }
  return out.join("\n");
}

/**
 * 기록 노트 전체를 다시 쓴다: 확인 대기 목록은 새로, 기록은 새 칸을 맨 위에 넣고 오래된 것은 지운다
 * @param {string} text  지금 기록 노트 (없으면 "")
 * @param {string|null} entry  새 칸 (확인 대기 목록만 고칠 때는 null)
 * @param {{link:string, job:string}[]} pending
 */
export function buildLog(text, entry, pending) {
  text = (text || "").replace(/\r\n/g, "\n");
  const at = text.indexOf(`\n${LOG_HEAD}\n`);
  const old = at < 0 ? [] : text.slice(at + LOG_HEAD.length + 2).split(/\n(?=### )/).map((s) => s.trim()).filter((s) => s.startsWith("### "));
  const entries = (entry ? [entry, ...old] : old).slice(0, MAX_ENTRIES);
  const wait = pending.length ? pending.map((p) => `- ${p.link} — ${p.job}`).join("\n") : "없음";
  return `# ${LOG_NAME}\n\n${PENDING_HEAD}\n\n${wait}\n\n${LOG_HEAD}\n\n${entries.join("\n\n")}\n`;
}
