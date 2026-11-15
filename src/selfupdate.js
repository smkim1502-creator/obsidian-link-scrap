// PC: 플러그인 폴더의 파일이 새 버전으로 바뀌면 옵시디언을 다시 켜지 않아도 스스로 다시 불러온다.
// (휴대폰은 BRAT이 업데이트하면서 다시 불러 주므로 PC에서만 쓴다)
//
// stat()  : 지금 파일 상태를 나타내는 문자열(시각·크기). 못 읽으면 null
// busy()  : 하던 일이 있으면 true — 끝날 때까지 미룬다
// reload(): 플러그인을 껐다 켠다
export function watchFiles({ stat, busy = () => false, reload, con = console }) {
  let loaded = null; // 이 코드를 불러올 때의 파일 상태
  let last = null; // 직전에 본 상태
  let started = false;

  async function check() {
    if (started) return false;
    let now = null;
    try {
      now = await stat();
    } catch (e) {
      return false;
    }
    if (!now) return false;
    if (loaded === null) {
      loaded = last = now;
      return false;
    }
    // 복사가 끝났는지 알 수 없으므로, 두 번 이어서 같은 상태일 때만 다시 불러온다
    const settled = now === last;
    last = now;
    if (now === loaded || !settled || busy() || started) return false;
    started = true; // 실패해도 되풀이하지 않는다. 다음에 옵시디언을 켜면 새 파일이 불린다
    try {
      await reload();
    } catch (e) {
      con.error("[link-scrap] 새 버전을 다시 불러오지 못함", e);
    }
    return true;
  }

  return { check };
}

// 옵시디언의 플러그인 관리자로 껐다 켠다. 켜기 전에 manifest를 다시 읽혀 버전 표시도 새것이 되게 한다
export async function reloadPlugin(plugins, id) {
  await plugins.disablePlugin(id);
  try {
    await plugins.loadManifests?.();
  } catch (e) {
    // manifest를 못 읽어도 켜기는 한다
  }
  await plugins.enablePlugin(id);
}
