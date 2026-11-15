// Remotely Save 자동 동기화 알림: node test/syncnotice.mjs
// 가짜 Remotely Save 객체로 0.5.25가 동기화 때 부르는 순서를 그대로 흉내 낸다.
import assert from "node:assert/strict";
import { watchSync, TAG } from "../src/syncnotice.js";

const EN = {
  syncrun_shortstep1: "1/2 Remotely Save starts running ({{serviceType}})",
  syncrun_shortstep2: "2/2 Remotely Save finished!",
};

// Remotely Save와 같은 모양: updateLastSyncMsg는 프로토타입에 있고, 상태 표시줄이 없으면(휴대폰) 바로 돌아간다
class FakeRS {
  settings = { serviceType: "onedrive" };
  isSyncing = false;
  calls = [];
  i18n = { t: (key, vars = {}) => EN[key].replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]) };
  constructor(con) {
    this.con = con;
  }
  updateLastSyncMsg(source, status, ok, failed) {
    this.calls.push([source, status, ok, failed]);
  }
  // ax()가 부르는 순서: 1단계 → (2~7단계는 상태 그대로) → 오류면 console.error → 8단계
  run(source, error) {
    this.isSyncing = true;
    this.updateLastSyncMsg(source, "syncing", -1, -1);
    if (error) this.con.error(error);
    if (error) this.updateLastSyncMsg(source, "not_syncing", null, 1700000000000);
    else this.updateLastSyncMsg(source, "not_syncing", 1700000000000, null);
    this.isSyncing = false;
  }
}

function setup({ on = true } = {}) {
  const logged = [];
  const con = { error: (...a) => logged.push(a) };
  const baseError = con.error;
  const out = [];
  const state = { rs: new FakeRS(con), on };
  const w = watchSync({ getPlugin: () => state.rs, notify: (m, ms) => out.push([m, ms]), enabled: () => state.on, con });
  w.check();
  return { w, out, con, baseError, logged, state };
}
const START = `1/2 Remotely Save starts running (onedrive)${TAG}`;
const DONE = `2/2 Remotely Save finished!${TAG}`;

// 1) 앱을 켠 뒤 첫 동기화: 시작과 끝을 Remotely Save 문장 그대로 + (링크 스크랩)
{
  const { out, state, con, baseError } = setup();
  state.rs.run("auto_once_init");
  assert.deepEqual(out, [[START, undefined], [DONE, undefined]]);
  assert.equal(DONE, "2/2 Remotely Save finished! (링크 스크랩)");
  assert.equal(con.error, baseError); // 동기화가 끝나면 console.error를 원래대로
  assert.equal(state.rs.calls.length, 2); // 원래 함수도 그대로 불린다
}
console.log("1 시작·끝 알림 OK:", START, "/", DONE);

// 2) 주기 동기화는 시작·끝, 저장 뒤 동기화는 끝만
{
  const { out, state } = setup();
  state.rs.run("auto");
  state.rs.run("auto_sync_on_save");
  assert.deepEqual(out.map((x) => x[0]), [START, DONE, DONE]);
}
console.log("2 주기·저장 뒤 OK");

// 3) 직접 실행·시험 실행은 Remotely Save가 스스로 알리므로 겹쳐 띄우지 않는다
{
  const { out, state } = setup();
  state.rs.run("manual");
  state.rs.run("dry");
  state.rs.run("manual", new Error("x"));
  assert.deepEqual(out, []);
}
console.log("3 직접 실행은 건너뜀 OK");

// 4) 실패: Remotely Save가 남긴 오류 문장을 10초 동안. 끝났다는 알림은 띄우지 않는다
{
  const { out, state, logged, con, baseError } = setup();
  const abort = "Abort! you set changing files >= 60% is not allowed but 400/591=67.7% is going to be modified or deleted! If you are sure you want this sync, please adjust the allowed ratio in the settings.";
  state.rs.run("auto_sync_on_save", new Error(abort));
  assert.deepEqual(out, [[abort + TAG, 10000]]);
  assert.equal(logged.length, 1); // 원래 console.error도 그대로 찍힌다
  assert.equal(con.error, baseError);
  // 여러 오류가 묶여 오면 하나씩
  out.length = 0;
  const many = new Error("AggregateError");
  many.errors = [new Error("first"), new Error("second")];
  state.rs.run("auto", many);
  assert.deepEqual(out.map((x) => x[0]), [START, "first" + TAG, "second" + TAG]);
  // 오류 내용을 못 읽으면 Remotely Save의 기본 문장
  out.length = 0;
  state.rs.isSyncing = true;
  state.rs.updateLastSyncMsg("auto_sync_on_save", "syncing", -1, -1);
  state.rs.updateLastSyncMsg("auto_sync_on_save", "not_syncing", null, 1700000000000);
  assert.deepEqual(out, [["error while sync" + TAG, 10000]]);
  // 실패 뒤 다음 동기화가 잘 끝나면 앞의 오류가 다시 나오지 않는다
  out.length = 0;
  state.rs.run("auto_sync_on_save");
  assert.deepEqual(out.map((x) => x[0]), [DONE]);
}
console.log("4 실패 알림 OK");

// 5) 상태 표시줄을 30초마다 다시 그리는 호출(source 없음)에는 반응하지 않는다
{
  const { out, state } = setup();
  state.rs.updateLastSyncMsg(undefined, "not_syncing", 1700000000000, null);
  state.rs.updateLastSyncMsg(undefined, "not_syncing", null, 1700000000000);
  // 시작 없이 끝만 온 경우도 무시
  state.rs.updateLastSyncMsg("auto", "not_syncing", 1700000000000, null);
  assert.deepEqual(out, []);
}
console.log("5 상태 표시줄 갱신 무시 OK");

// 6) 설정에서 끄면 조용하고, 켜면 다시 나온다 (도는 중에 끄면 끝 알림도 없음)
{
  const { out, state } = setup({ on: false });
  state.rs.run("auto_once_init");
  state.rs.run("auto", new Error("boom"));
  assert.deepEqual(out, []);
  state.on = true;
  state.rs.run("auto_sync_on_save");
  assert.deepEqual(out.map((x) => x[0]), [DONE]);
}
console.log("6 끄기 OK");

// 7) 연결하기 전에 이미 돌고 있던 동기화(앱을 켠 직후)도 시작·끝을 알린다
{
  const logged = [];
  const con = { error: (...a) => logged.push(a) };
  const rs = new FakeRS(con);
  rs.isSyncing = true;
  const out = [];
  const w = watchSync({ getPlugin: () => rs, notify: (m) => out.push(m), con });
  w.check();
  assert.deepEqual(out, [START]);
  rs.updateLastSyncMsg("auto_once_init", "not_syncing", 1700000000000, null);
  assert.deepEqual(out, [START, DONE]);
}
console.log("7 이미 도는 동기화 OK");

// 8) 연결 풀기: 함수와 console.error를 원래대로. 플러그인이 꺼졌다 켜지면 새 객체에 다시 연결
{
  const { w, out, state, con, baseError } = setup();
  const first = state.rs;
  assert.ok(Object.hasOwn(first, "updateLastSyncMsg"));
  w.check(); // 여러 번 불러도 한 번만 감싼다
  first.run("auto_sync_on_save");
  assert.equal(out.length, 1);
  // Remotely Save가 다시 켜져 새 객체가 됨
  state.rs = new FakeRS(con);
  w.check();
  assert.ok(!Object.hasOwn(first, "updateLastSyncMsg")); // 옛 객체는 원래대로
  first.run("auto"); // 옛 객체의 호출은 알리지 않는다
  assert.equal(out.length, 1);
  state.rs.run("auto_sync_on_save");
  assert.equal(out.length, 2);
  // Remotely Save가 꺼짐
  const second = state.rs;
  state.rs = undefined;
  w.check();
  assert.ok(!Object.hasOwn(second, "updateLastSyncMsg"));
  // 도는 중에 링크 스크랩이 꺼져도 console.error가 원래대로
  state.rs = new FakeRS(con);
  w.check();
  state.rs.isSyncing = true;
  state.rs.updateLastSyncMsg("auto", "syncing", -1, -1);
  assert.notEqual(con.error, baseError);
  w.stop();
  assert.equal(con.error, baseError);
  assert.ok(!Object.hasOwn(state.rs, "updateLastSyncMsg"));
  state.rs.updateLastSyncMsg("auto", "not_syncing", 1700000000000, null);
  assert.equal(out.length, 3); // 시작 알림 하나만 늘고, 푼 뒤에는 없음
}
console.log("8 연결 풀기·다시 연결 OK");

// 9) 문구를 플러그인에서 못 읽어도 같은 영어 문장, 알림이 실패해도 동기화는 그대로
{
  const con = { error: () => {} };
  const rs = new FakeRS(con);
  rs.i18n = undefined;
  const out = [];
  const w = watchSync({ getPlugin: () => rs, notify: (m) => out.push(m), con });
  w.check();
  rs.run("auto_once_init");
  assert.deepEqual(out, [START, DONE]);
  const rs2 = new FakeRS(con);
  const w2 = watchSync({ getPlugin: () => rs2, notify: () => { throw new Error("no notice"); }, con });
  w2.check();
  rs2.run("auto");
  assert.equal(rs2.calls.length, 2);
  // 플러그인이 없거나 모양이 다르면 아무 일도 하지 않는다
  const w3 = watchSync({ getPlugin: () => ({}), notify: (m) => out.push(m), con });
  w3.check();
  watchSync({ getPlugin: () => { throw new Error("x"); }, notify: () => {}, con }).check();
}
console.log("9 문구 대체·예외 OK");
console.log("모두 통과");
