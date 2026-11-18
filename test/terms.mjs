// 번역 용어집: node test/terms.mjs
import assert from "node:assert/strict";
import { parseTerms, termLines, applyTerms, claudePrompt, finishDraft, transformArticle } from "../src/transform.js";

// 1) 읽기: "- A → B", "->", "=" 를 받고 제목·설명·빈 줄은 건너뛴다. 긴 표기부터
const terms = parseTerms("# 번역 용어집\n\n설명 줄 - 무시 → 안 됨\n- カービィ → 커비\n* 카비 -> 커비\n- 星のカービィ = 별의 커비\n");
assert.deepEqual(terms, [["星のカービィ", "별의 커비"], ["カービィ", "커비"], ["카비", "커비"]]);
// 같은 표기는 "그대로 둔다"
assert.deepEqual(parseTerms("- 3DS → 3DS\n"), [["3DS", "3DS"]]);
console.log("1 읽기 OK");

// 2) 바꾸기: 잘못 옮긴 한국어 표기와 남은 원어를 바꾸고, 바꾼 결과를 다시 바꾸지 않는다
assert.equal(applyTerms("『카비의 에어라이더』와 星のカービィ, カービィ", terms), "『커비의 에어라이더』와 별의 커비, 커비");
assert.equal(applyTerms("가 → 나", [["가", "가나"], ["나", "다"]]), "가나 → 다");
// 로마자 원어는 결과에서 바꾸지 않는다 (링크 주소·영어 낱말 보호)
assert.equal(applyTerms("[Link](https://x/Link) 봄츄", [["Link", "링크"], ["봄츄", "봄추"]]), "[Link](https://x/Link) 봄추");
assert.equal(applyTerms("그대로", []), "그대로");
console.log("2 바꾸기 OK");

// 3) 지시문: 글에 나오는 원어만 Claude에게 알려 준다 (번역할 때만)
assert.equal(termLines(terms, "カービィのエアライダー"), "カービィ → 커비");
const p = claudePrompt({ title: "『カービィのエアライダー』", markdown: "本文" }, { translate: true, summary: true }, terms);
assert.ok(p.includes("사용자 용어집") && p.includes("カービィ → 커비") && !p.includes("카비 → 커비"), p);
assert.ok(!claudePrompt({ title: "『カービィ』", markdown: "本文" }, { translate: false, summary: true }, terms).includes("용어집"));
console.log("3 지시문 OK");

// 4) Claude가 놓쳐도 결과에 한 번 더 적용 (요약·번역 확인)
const a = { title: "『カービィのエアライダー』を60fpsに", markdown: "カービィの最適化。\n" };
const prompts = [];
const run = async (prompt) => (prompts.push(prompt), "# 『카비의 에어라이더』를 60fps로\n\n카비 최적화 이야기다.\n\n- 하나다.\n- 둘이다.\n- 셋이다.");
const s = await finishDraft(a, null, { translate: true, summary: true }, run, { terms });
assert.equal(s.title, "『커비의 에어라이더』를 60fps로");
assert.ok(s.markdown.includes("커비 최적화") && !s.markdown.includes("카비"));
assert.ok(prompts[0].includes("カービィ → 커비"));
// 원문 그대로 요약(번역 안 함)은 바꾸지 않는다
const raw = await finishDraft(a, null, { translate: false, summary: true }, async () => "# 『カービィ』\n\nカービィ 카비.", { terms });
assert.ok(raw.markdown.includes("カービィ 카비"));
// 번역 확인
const r = await finishDraft(a, { title: "『카비의 에어라이더』를 60fps로", markdown: "카비의 최적화.\n" }, { translate: true, summary: false }, async (prompt) => (prompts.push(prompt), "없음"), { terms });
assert.equal(r.title, "『커비의 에어라이더』를 60fps로");
assert.ok(r.markdown.includes("커비의 최적화"));
assert.ok(prompts.at(-1).includes("カービィ → 커비"));
console.log("4 Claude 결과에 적용 OK");

// 5) 휴대폰 초안(구글 번역)에도 적용
const post = async (url, body) => {
  const qs = body.split("&").map((q) => decodeURIComponent(q.slice(2)));
  const tr = qs.map((q) => (q.includes("カービィ") ? q.replace(/『カービィのエアライダー』/, "『카비의 에어라이더』").replace(/[^\s『』0-9a-z가-힣]+/g, "카비") : q));
  return { status: 200, text: JSON.stringify(tr.length === 1 ? [tr[0], "ja"] : tr.map((t) => [t, "ja"])) };
};
const t = await transformArticle(a, { translate: true, summary: false }, { post, terms });
assert.ok(!/카비/.test(t.title + t.markdown) && /커비/.test(t.title), t.title + " / " + t.markdown);
console.log("5 휴대폰 초안 OK");
console.log("모두 통과");
