// Remotely Save의 자동 동기화(앱을 켤 때·저장 뒤·주기)가 시작했는지, 끝났는지, 실패했는지를 알림으로 보여 준다.
// Remotely Save는 직접 실행한 동기화에만 알림을 띄워서, 휴대폰에서는 자동 동기화가 끝났는지 실패했는지 알 길이 없다.
// 문구는 Remotely Save가 직접 실행 때 쓰는 문장 그대로 쓰고 끝에 (링크 스크랩)을 붙인다.
export const RS_ID = "remotely-save";
export const TAG = " (링크 스크랩)";

// Remotely Save 0.5.25의 영어 문구. 플러그인에서 읽지 못할 때만 쓴다
const FALLBACK = {
  syncrun_shortstep1: "1/2 Remotely Save starts running ({{serviceType}})",
  syncrun_shortstep2: "2/2 Remotely Save finished!",
};
const ERROR_FALLBACK = "error while sync";
const ERROR_MS = 10000; // Remotely Save가 오류 알림에 쓰는 시간

function phrase(rs, key, vars = {}) {
  try {
    const s = rs.i18n?.t?.(key, vars);
    if (typeof s === "string" && s && s !== key) return s;
  } catch {}
  return FALLBACK[key].replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function errorLines(e) {
  const list = Array.isArray(e?.errors) && e.errors.length ? e.errors : [e];
  const lines = list.map((x) => (typeof x?.message === "string" ? x.message.trim() : "")).filter(Boolean);
  return lines.length ? lines : [ERROR_FALLBACK];
}

/**
 * @param getPlugin  지금 켜져 있는 Remotely Save 플러그인 객체(없으면 undefined)
 * @param notify     (문구, 표시 시간ms|undefined) → 알림 띄우기
 * @param enabled    지금 알림을 띄울지
 * @param con        오류 내용을 읽을 console (테스트에서 바꿔 끼운다)
 * @returns check(): 플러그인이 새로 켜졌거나 바뀌었으면 다시 연결 / stop(): 연결 풀기
 */
export function watchSync({ getPlugin, notify, enabled = () => true, con = console }) {
  let hooked = null; // { rs, wrapper, original, own }
  let running = false;
  let captured = null;
  let tap = null; // { prev, mine }

  // 동기화가 도는 동안만 console.error를 지켜본다. Remotely Save는 실패 원인을 여기에만 남긴다
  const startCapture = () => {
    captured = null;
    if (tap) return;
    const prev = con.error;
    const mine = function (...args) {
      const e = args.find((a) => a && typeof a.message === "string");
      if (e) captured = e;
      return prev.apply(this, args);
    };
    tap = { prev, mine };
    con.error = mine;
  };
  const stopCapture = () => {
    if (tap && con.error === tap.mine) con.error = tap.prev;
    tap = null;
    const e = captured;
    captured = null;
    return e;
  };

  const shows = (source) => source !== "manual" && source !== "dry" && enabled();
  const say = (text, ms) => {
    try {
      notify(text + TAG, ms);
    } catch {}
  };

  const begin = (rs, source) => {
    running = true;
    startCapture();
    // 저장 뒤 동기화는 글을 쓰는 동안 계속 돌아서, 시작 알림은 빼고 끝났다는 알림만 띄운다
    if (source !== "auto_sync_on_save" && shows(source))
      say(phrase(rs, "syncrun_shortstep1", { serviceType: rs.settings?.serviceType ?? "" }));
  };

  const onStatus = (rs, source, status, lastSuccess) => {
    // source가 없는 호출은 상태 표시줄을 30초마다 다시 그리는 것
    if (source === undefined) return;
    if (status === "syncing") return begin(rs, source);
    if (status !== "not_syncing" || !running) return;
    running = false;
    const error = stopCapture();
    if (!shows(source)) return;
    if (typeof lastSuccess === "number" && lastSuccess > 0) say(phrase(rs, "syncrun_shortstep2"));
    else for (const line of errorLines(error)) say(line, ERROR_MS);
  };

  const unhook = () => {
    if (!hooked) return;
    const { rs, wrapper, original, own } = hooked;
    hooked = null;
    if (rs.updateLastSyncMsg === wrapper) {
      if (own) rs.updateLastSyncMsg = original;
      else delete rs.updateLastSyncMsg;
    }
    running = false;
    stopCapture();
  };

  const hook = (rs) => {
    const own = Object.prototype.hasOwnProperty.call(rs, "updateLastSyncMsg");
    const original = rs.updateLastSyncMsg;
    const wrapper = function (source, status, lastSuccess, ...rest) {
      // 연결을 푼 뒤에 남은 호출은 그대로 흘려보낸다
      if (hooked?.wrapper === wrapper) {
        try {
          onStatus(rs, source, status, lastSuccess);
        } catch {}
      }
      return original.call(this, source, status, lastSuccess, ...rest);
    };
    rs.updateLastSyncMsg = wrapper;
    hooked = { rs, wrapper, original, own };
    // 연결하기 전에 이미 돌고 있던 동기화(앱을 켠 직후)도 알린다
    if (rs.isSyncing === true) begin(rs, "auto_once_init");
  };

  const check = () => {
    let rs;
    try {
      rs = getPlugin();
    } catch {}
    if (rs && typeof rs.updateLastSyncMsg !== "function") rs = undefined;
    if (rs === (hooked?.rs ?? undefined) && (!hooked || rs.updateLastSyncMsg === hooked.wrapper)) return;
    unhook();
    if (rs) hook(rs);
  };

  return { check, stop: unhook };
}
