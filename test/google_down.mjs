// 구글 번역이 막혔을 때(HTTP 429 등): node test/google_down.mjs
import assert from "node:assert/strict";
import { googleTranslate, transformArticle, GoogleDown } from "../src/transform.js";

const ok = (texts) => ({ status: 200, text: JSON.stringify(texts.length === 1 ? ["번역됨", "ja"] : texts.map(() => ["번역됨", "ja"])) });
const parse = (body) => body.split("&").map((q) => decodeURIComponent(q.slice(2)));

// 1) 429·5xx는 쉬었다가 다시 보내고, 풀리면 그대로 번역한다
{
  const seen = [];
  const post = async (url, body) => {
    seen.push(seen.length < 2 ? 429 : 200);
    return seen.length <= 2 ? { status: seen.length === 1 ? 429 : 503, text: "" } : ok(parse(body));
  };
  assert.deepEqual(await googleTranslate(["こんにちは"], post, { waits: [1, 1] }), ["번역됨"]);
  assert.equal(seen.length, 3);
}
console.log("1 다시 보내기 OK");

// 2) 계속 막히면 GoogleDown. 400 같은 다른 오류는 다시 보내지 않는다
{
  let n = 0;
  await assert.rejects(googleTranslate(["a"], async () => (n++, { status: 429, text: "" }), { waits: [1, 1] }), (e) => e instanceof GoogleDown && /HTTP 429/.test(e.message));
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(googleTranslate(["a"], async () => (n++, { status: 400, text: "" }), { waits: [1, 1] }), GoogleDown);
  assert.equal(n, 1);
}
console.log("2 계속 막힘 OK");

// 3) 휴대폰(Claude 없음): 번역·요약 어느 쪽이든 원문 그대로 + 나중에 PC가 마무리하도록 retry
const a = {
  title: "『エアライダー』を60fpsに導いた最適化",
  markdown: "パドックに多数のプレイヤーが集まる場面では描画負荷が高まります。\n\n高負荷時には内部の描画解像度を下げます。解像度の切り替えをプレイヤーに意識させない制御ノウハウも紹介。\n",
};
const down = async () => ({ status: 429, text: "" });
for (const mode of [{ translate: true, summary: false }, { translate: true, summary: true }]) {
  const t = await transformArticle(a, mode, { post: down });
  assert.equal(t.raw, true);
  assert.equal(t.retry, true);
  assert.equal(t.done, false);
  assert.equal(t.title, a.title);
  assert.equal(t.markdown, a.markdown);
  assert.equal(t.translated, true);
  assert.equal(t.summarized, mode.summary);
  assert.match(t.warning, /HTTP 429.*원문으로 저장/);
}
console.log("3 휴대폰 원문 저장 + 확인 대기 OK");

// 4) PC: 요약은 Claude가 원문으로 하므로 구글이 막혀도 된다. 번역만은 초안이 없어 원문 + 대기
{
  const runClaude = async () => "# 요약 제목\n\n- 하나\n- 둘\n";
  const s = await transformArticle(a, { translate: true, summary: true }, { post: down, runClaude });
  assert.equal(s.raw, undefined);
  const t = await transformArticle(a, { translate: true, summary: false }, { post: down, runClaude });
  assert.equal(t.raw, true);
  assert.equal(t.retry, true);
  // Claude도 실행되지 않고 구글도 막히면 원문 + 대기
  const fail = async () => {
    throw new Error("로그인 만료");
  };
  const u = await transformArticle(a, { translate: true, summary: true }, { post: down, runClaude: fail });
  assert.equal(u.raw, true);
  assert.equal(u.retry, true);
  assert.equal(u.markdown, a.markdown);
}
console.log("4 PC OK");
console.log("모두 통과");
