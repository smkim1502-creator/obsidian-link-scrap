// PC에서 새 버전 파일을 스스로 다시 불러오기: node test/selfupdate.mjs
import assert from "node:assert/strict";
import { watchFiles, reloadPlugin } from "../src/selfupdate.js";

function setup() {
  const state = { files: "100:5:100:1", busy: false, reloads: 0, fail: false };
  const w = watchFiles({
    stat: async () => {
      if (state.files === "throw") throw new Error("no file");
      return state.files;
    },
    busy: () => state.busy,
    reload: async () => {
      state.reloads++;
      if (state.fail) throw new Error("x");
    },
    con: { error: () => {} },
  });
  return { state, w };
}

// 1) 파일이 그대로면 아무 일도 없다
{
  const { state, w } = setup();
  for (let i = 0; i < 5; i++) assert.equal(await w.check(), false);
  assert.equal(state.reloads, 0);
}
console.log("1 그대로면 조용 OK");

// 2) 파일이 바뀌면 바로가 아니라, 다음 확인에서도 같은 상태일 때 한 번만 다시 불러온다
{
  const { state, w } = setup();
  await w.check();
  state.files = "200:6:100:1"; // main.js만 먼저 복사됨
  assert.equal(await w.check(), false);
  state.files = "200:6:200:1"; // manifest.json도 복사됨
  assert.equal(await w.check(), false);
  assert.equal(state.reloads, 0);
  assert.equal(await w.check(), true);
  assert.equal(state.reloads, 1);
  await w.check();
  await w.check();
  assert.equal(state.reloads, 1);
}
console.log("2 복사가 끝난 뒤 한 번만 OK");

// 3) 하던 일이 있으면 끝날 때까지 미룬다
{
  const { state, w } = setup();
  await w.check();
  state.files = "200:6:200:1";
  state.busy = true;
  await w.check();
  await w.check();
  await w.check();
  assert.equal(state.reloads, 0);
  state.busy = false;
  assert.equal(await w.check(), true);
  assert.equal(state.reloads, 1);
}
console.log("3 하던 일 뒤로 미룸 OK");

// 4) 파일을 못 읽는 동안은 건너뛰고, 다시 불러오기가 실패해도 되풀이하지 않는다
{
  const { state, w } = setup();
  await w.check();
  state.files = "throw";
  assert.equal(await w.check(), false);
  state.files = null;
  assert.equal(await w.check(), false);
  state.files = "200:6:200:1";
  state.fail = true;
  await w.check();
  await w.check();
  await w.check();
  await w.check();
  assert.equal(state.reloads, 1);
  // 처음부터 못 읽으면 기준이 없으므로, 읽힌 때를 기준으로 삼는다
  const s2 = setup();
  s2.state.files = null;
  await s2.w.check();
  s2.state.files = "300:1:300:1";
  await s2.w.check();
  await s2.w.check();
  await s2.w.check();
  assert.equal(s2.state.reloads, 0);
}
console.log("4 못 읽음·실패 OK");

// 5) 껐다 켜는 순서: 끄기 → manifest 다시 읽기 → 켜기. manifest 읽기가 없거나 실패해도 켠다
{
  const calls = [];
  await reloadPlugin({ disablePlugin: async (id) => calls.push("off " + id), loadManifests: async () => calls.push("manifests"), enablePlugin: async (id) => calls.push("on " + id) }, "link-scrap");
  assert.deepEqual(calls, ["off link-scrap", "manifests", "on link-scrap"]);
  calls.length = 0;
  await reloadPlugin({ disablePlugin: async () => calls.push("off"), enablePlugin: async () => calls.push("on") }, "x");
  await reloadPlugin({ disablePlugin: async () => calls.push("off"), loadManifests: async () => { throw new Error("x"); }, enablePlugin: async () => calls.push("on") }, "x");
  assert.deepEqual(calls, ["off", "on", "off", "on"]);
}
console.log("5 껐다 켜는 순서 OK");
console.log("모두 통과");
