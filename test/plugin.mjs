// 플러그인 코드 경로 전체를 가짜 옵시디언 환경에서 실행: node test/plugin.mjs
import esbuild from "esbuild";
import assert from "node:assert/strict";

await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "esm",
  platform: "node",
  // 번들과 테스트가 같은 가짜 obsidian 모듈 인스턴스를 쓰도록 외부 모듈로 연결
  plugins: [{ name: "mock", setup: (b) => b.onResolve({ filter: /^obsidian$/ }, () => ({ path: new URL("./obsidian-mock.js", import.meta.url).href, external: true })) }],
  external: ["jsdom", "turndown", "turndown-plugin-gfm"],
  outfile: "test/tmp_build/main.mjs",
  logLevel: "warning",
});
const mock = await import("./obsidian-mock.js");
const { default: LinkScrapPlugin } = await import("./tmp_build/main.mjs");

const { draftHash, markerLine } = await import("../src/pending.js");

const vault = new mock.Vault();
await vault.createFolder("스크랩");
await vault.createFolder("스크랩/AI");
const opened = [];
const app = mock.makeApp(vault, opened);
const plugin = new LinkScrapPlugin(app);
await plugin.onload();
const MARK = (words) => new RegExp(`^Claude: ${words} 확인 대기 \\([0-9a-f]{8}\\)$`, "m");

// 0) 설정: 관련 노트 링크는 기본으로 끔. 예전에 저장된 '켬'과 번역·요약 기본값은 처음 켤 때 한 번 정리한다
assert.equal(plugin.settings.autoLinks, false);
const migrate = async (data) => {
  const p = new LinkScrapPlugin(mock.makeApp(new mock.Vault()));
  let written = null;
  p.loadData = async () => data;
  p.saveData = async (d) => (written = { ...d });
  await p.onload();
  return { settings: p.settings, written };
};
const old = await migrate({ autoLinks: true, maxRelated: 5, defaultTranslate: true, defaultSummary: false, engine: "claude" });
assert.equal(old.settings.autoLinks, false);
assert.equal(old.written.settingsVersion, 2);
assert.ok(!("defaultTranslate" in old.written) && !("engine" in old.written) && old.written.maxRelated === 5);
const kept = await migrate({ autoLinks: true, settingsVersion: 2 }); // 정리 뒤에 다시 켠 것은 그대로
assert.ok(kept.settings.autoLinks === true && kept.written === null);
console.log("0 설정 정리 OK");

// 1) 기본 스크랩 + 태그 + 폴더
const f1 = await plugin.scrap("https://news.hada.io/topic?id=29185", "스크랩/AI", ["AI", "경제/고용"]);
assert.ok(f1, mock.notices.at(-1));
assert.equal(f1.path, "스크랩/AI/AI로 인한 고용 종말이 (아마도) 일어나지 않을 이유.md");
assert.match(f1.data, /^---\nurl: https:\/\/news\.hada\.io\/topic\?id=29185\ntags:\n  - AI\n  - 경제\/고용\n---\n# AI로 인한/);
console.log("1 기본 스크랩 OK:", f1.path);

// 2) 같은 링크(추적 파라미터만 다름)는 새로 만들지 않는다
const before = vault.files.size;
const f2 = await plugin.scrap("https://news.hada.io/topic?id=29185&utm_source=x", "스크랩", []);
assert.equal(f2, f1);
assert.equal(vault.files.size, before);
console.log("2 중복 감지 OK:", mock.notices.at(-1));

// 2-1) 창 그리기: 입력창과 빠른 고르기 창 모두 저장 형태 버튼 네 개, 누르면 그 형태로. 입력창에서 Enter로는 저장하지 않는다
const buttonsOf = (m) => [...m.contentEl.querySelectorAll("button")];
await plugin.openModal("https://example.com/a");
const full = mock.modals.at(-1);
full.onOpen();
assert.equal(full.contentEl.querySelector("input").value, "https://example.com/a");
assert.deepEqual(buttonsOf(full).map((b) => b.textContent), ["원문 · 전문", "원문 · 요약", "번역 · 전문", "번역 · 요약"]);
let picked = null;
full.pick = (m) => (picked = m);
full.contentEl.querySelector("input").dispatchEvent(new full.contentEl.ownerDocument.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
assert.equal(picked, null, "Enter로 저장하면 안 됨");
assert.match(mock.notices.at(-1), /저장 형태를 눌러/);
buttonsOf(full)[3].click();
assert.deepEqual(picked, { translate: true, summary: true });
plugin.chooseMode("https://example.com/b", "스크랩", []);
const quick = mock.modals.at(-1);
quick.onOpen();
quick.pick = (m) => (picked = m);
buttonsOf(quick).find((x) => x.textContent === "원문 · 요약").click();
assert.ok(quick.contentEl.textContent.includes("https://example.com/b") && picked.summary && !picked.translate);
console.log("2-1 저장 형태 버튼 OK");

// 2-2) 탭 보내기: 빠른 창 위쪽에 이유 버튼(설정 목록 + 새 이유), 누르면 이유 노트에 체크박스 한 줄
assert.deepEqual(
  buttonsOf(quick).map((x) => x.textContent),
  ["해 보고 싶은 것", "읽을거리", "볼거리", "생각 재료", "만들고 싶은 것", "사고 싶은 것", "+ 새 이유", "원문 · 전문", "원문 · 요약", "번역 · 전문", "번역 · 요약"]
);
const reasonOf = (name) => plugin.settings.reasons.find((r) => r.name === name);
const search = "https://www.google.com/search?q=%ED%81%B4%EB%A1%9C%EB%93%9C+%EC%BB%B4%ED%93%A8%ED%84%B0+%EC%9C%A0%EC%A6%88&oq=x&client=ms-android";
plugin.chooseMode(search, "__auto__", []);
const q2 = mock.modals.at(-1);
q2.onOpen();
const whyInput = q2.contentEl.querySelector("textarea");
assert.match(whyInput.placeholder, /^설명/);
whyInput.value = "나중에\n써 보고 싶어서";
whyInput.dispatchEvent(new q2.contentEl.ownerDocument.defaultView.Event("input"));
buttonsOf(q2).find((x) => x.textContent === "해 보고 싶은 것").click();
await new Promise((r) => setTimeout(r, 50));
const todo = vault.getAbstractFileByPath("수집함/해 보고 싶은 것.md");
assert.ok(todo, "이유 노트가 생겨야 함");
// 설명이 첫 줄, 둘째 줄(들여쓰기)에 스크랩 날짜와 링크
assert.match(todo.data, /^# 해 보고 싶은 것\n\n- \[ \] 나중에 써 보고 싶어서\n\t- \d{4}-\d\d-\d\d 스크랩 · \[구글 검색: 클로드 컴퓨터 유즈\]\(https:\/\/www\.google\.com\/search\?q=[^)]+\)\n$/);
assert.match(mock.notices.at(-1), /「해 보고 싶은 것」에 넣었습니다/);
// 같은 링크는 한 번만
await plugin.sendTab(search, reasonOf("해 보고 싶은 것"));
assert.equal(todo.data.split("\n").filter((l) => l.startsWith("- [ ]")).length, 1);
assert.match(mock.notices.at(-1), /이미 「해 보고 싶은 것」에 있는 링크/);
// 링크만: 페이지 제목을 가져와 적는다
await plugin.sendTab("https://www.nintendo.co.jp/jobs/keyword/181.html", reasonOf("만들고 싶은 것"));
const make = vault.getAbstractFileByPath("수집함/만들고 싶은 것.md");
// 설명이 없으면 첫 줄은 링크, 둘째 줄은 날짜만
assert.match(make.data, /^- \[ \] \[.*ゲームチャット.*\]\(https:\/\/www\.nintendo\.co\.jp\/jobs\/keyword\/181\.html\)\n\t- \d{4}-\d\d-\d\d 스크랩\n/m);
// 읽을거리: 본문까지 스크랩(노트는 열지 않음, 한국어 글은 번역 안 한다는 알림 없음)하고 그 노트를 링크
const nOpened = opened.length;
await plugin.sendTab("https://m.ruliweb.com/nin/board/300004/read/2365831?page=3", reasonOf("읽을거리"), "주말에");
const read = vault.getAbstractFileByPath("수집함/읽을거리.md");
assert.match(read.data, /^- \[ \] 주말에\n\t- \d{4}-\d\d-\d\d 스크랩 · \[\[[^\]]+\]\] · \[원문\]\(https:\/\/m\.ruliweb\.com\/nin\/board\/300004\/read\/2365831[^)]*\)\n/m, read.data);
assert.equal(opened.length, nOpened, "탭 보내기는 노트를 열지 않음");
assert.ok(!mock.notices.some((n) => /한국어 글이라 번역하지/.test(n)));
// 창에서 새 이유를 만들고 바로 보낸다
plugin.chooseMode("https://www.nintendo.co.jp/jobs/keyword/124.html", "__auto__", []);
const q3 = mock.modals.at(-1);
q3.onOpen();
buttonsOf(q3).find((x) => x.textContent === "+ 새 이유").click();
const nameInput = [...q3.contentEl.querySelectorAll("input")].at(-1);
nameInput.value = "  돈 생기면  ";
buttonsOf(q3).find((x) => x.textContent === "만들고 보내기").click();
await new Promise((r) => setTimeout(r, 3000));
assert.ok(reasonOf("돈 생기면"), "새 이유가 설정에 남아야 함");
assert.ok(vault.getAbstractFileByPath("수집함/돈 생기면.md")?.data.includes("keyword/124.html"));
// 주소로 부르기: &reason=…&desc=…(예전 이름 why도 받음)
await plugin.protocol({ action: "scrap", url: "https://www.google.com/search?q=%EB%AF%B8%EC%86%8C", reason: "해 보고 싶은 것", why: "표정 연습" });
assert.match(todo.data, /^- \[ \] 표정 연습\n\t- \d{4}-\d\d-\d\d 스크랩 · \[구글 검색: 미소\]\(/m);
await plugin.protocol({ action: "scrap", url: "https://www.google.com/search?q=%EC%9B%83%EC%9D%8C", reason: "해 보고 싶은 것", desc: "웃는 연습" });
assert.match(todo.data, /^- \[ \] 웃는 연습\n\t- \d{4}-\d\d-\d\d 스크랩 · \[구글 검색: 웃음\]\(/m);
// 설명 칸에 링크 주소만 넣은 경우는 설명으로 치지 않는다 (볼거리 노트에 주소가 두 번 적혔던 일)
const { cleanDesc } = await import("../src/reasons.js");
assert.equal(cleanDesc("https://sleepyzone.online/char-db-cn/", "https://sleepyzone.online/char-db-cn/"), "");
assert.equal(cleanDesc("https://a.com/x", "https://b.com/y"), "");
assert.equal(cleanDesc("옷 갈아입히기 사이트 https://a.com/x", "https://a.com/x"), "옷 갈아입히기 사이트");
assert.equal(cleanDesc("  두 줄\n설명  "), "두 줄 설명");
// 저장된 이유 목록을 불러와도 기본값을 건드리지 않는다
const loaded = await migrate({ settingsVersion: 2, reasons: [{ name: "하나뿐" }] });
assert.deepEqual(loaded.settings.reasons, [{ name: "하나뿐", scrap: "" }]);
console.log("2-2 탭 보내기 OK");
console.log(todo.data + read.data);

// 3) 공유 단축어 주소 → 저장 형태 고르는 창 → 고르면 저장. 이미지 없이 글만(디시 글은 이미지가 많다), 자동 분류를 끄면 마지막 폴더로 간다
plugin.settings.autoFolder = false;
const nFiles = vault.files.size;
await plugin.protocol({ action: "scrap", url: "디시 글 https://m.dcinside.com/board/thesingularity/1407506", tags: "AI" });
const chooser = mock.modals.at(-1);
assert.ok(chooser && chooser.url === "https://m.dcinside.com/board/thesingularity/1407506" && chooser.folder === "스크랩/AI");
assert.equal(vault.files.size, nFiles, "고르기 전에는 저장하지 않아야 함");
await chooser.pick({ translate: false, summary: false });
const f3 = [...vault.files.values()].find((f) => f.path === "스크랩/AI/AI 수학 발전의 역사.md");
assert.ok(f3, "디시 글 노트가 마지막 폴더(스크랩/AI)에 저장되어야 함");
assert.ok(!/!\[|<img|dcimg/i.test(f3.data), "이미지가 남으면 안 됨");
assert.ok(![...vault.files.keys()].some((p) => p.startsWith("_resources/")), "이미지 파일을 받으면 안 됨");
assert.ok(f3.data.split("\n# ")[1].length > 200, "글은 남아 있어야 함");
console.log("3 공유 주소→형태 고르기→글만 저장 OK");
console.log(f3.data.slice(0, 300));
plugin.settings.autoFolder = true;

// 3-1) 이미지 빼기: 링크 걸린 이미지·이미지만 있는 목록 줄·HTML 이미지는 빼고, 글과 코드 블록 안은 그대로
const { stripImages } = await import("./tmp_build/main.mjs");
assert.equal(
  stripImages("앞 문단\n\n![사진](https://x/a.jpg)\n\n[![画像](https://x/b.png)](https://x/b)\n- ![](https://x/c.gif)\n> ![[로컬.png]]\n글 ![아이콘](https://x/i.png) 중간 <img src=\"x\">끝\n\n```\n![코드 속](x)\n```\n"),
  "앞 문단\n\n글  중간 끝\n\n```\n![코드 속](x)\n```\n"
);
// 사진 설명: 연합뉴스(이미지 확대 + 굵은 사진 제목 + 이메일로 끝나는 설명), 네이버(기울임꼴 설명). 기사 첫 문단은 남긴다
assert.equal(
  stripImages("## 소제목\n\n__이미지 확대__ ![코스피](https://x/p.jpg)\n\n**코스피, 5% 급락**\n\n(서울=연합뉴스) 이진욱 기자 = 홍보관 모습. 2026.7.8 cityboy@yna.co.kr\n\n(서울=연합뉴스) 임은진 기자 = 코스피가 급락했다.\n"),
  "## 소제목\n\n(서울=연합뉴스) 임은진 기자 = 코스피가 급락했다.\n"
);
assert.equal(
  stripImages("![사진은 기사와 관련 없음  /게티이미지뱅크](https://x/a.jpg)\n\n_사진은 기사와 관련 없음 /게티이미지뱅크_\n\n“요즘 손님들은 다르다.”\n\n_강조한 문장도 본문이면 남는다_\n"),
  "“요즘 손님들은 다르다.”\n\n_강조한 문장도 본문이면 남는다_\n"
);
console.log("3-1 이미지·사진 설명 빼기 OK");

// 4) PDF
const f4 = await plugin.scrap("https://www.nintendo.co.jp/ir/pdf/2026/qa2606.pdf", "스크랩", []);
assert.ok(vault.files.has("스크랩/qa2606.pdf"));
assert.match(f4.data, /!\[\[qa2606\.pdf\]\]/);
console.log("4 PDF OK:", f4.path);

// 4-1) 자동 분류: 비교할 스크랩이 없으면 최상위 폴더
const f5 = await plugin.scrap("https://brunch.co.kr/@hiclemi/152", "__auto__", []);
assert.equal(f5.path, "스크랩/AI 시대, 비개발자는 무엇을 해야 하나.md");
console.log("4-1 자동 분류(빈 Vault → 최상위) OK:", mock.notices.at(-1).replace(/\n/g, " / "));

// 5) 실패 시 알림
await plugin.scrap("https://arca.live/b/aihomelab/185810092", "스크랩", []);
console.log("5 실패 알림:", mock.notices.at(-1));

// 6) 한국어 번역 (모의 환경은 모바일처럼 초안만): 제목·본문이 한국어, 이미지 주소는 그대로, 별칭 없음, Claude 확인 대기 표시
const f6 = await plugin.scrap("https://paulgraham.com/weird.html", "스크랩", [], { translate: true, summary: false });
assert.equal(f6.path, "스크랩/이상한 언어.md");
assert.match(f6.data, /^# 이상한 언어\n/m);
assert.ok(!f6.data.includes("weird-languages-5.gif"), "이미지는 빼야 함");
assert.ok(!/^aliases:/m.test(f6.data) && !f6.data.includes("⟦"));
assert.match(f6.data, MARK("번역"));
assert.match(mock.notices.at(-1), /PC 옵시디언에서 Claude가 마무리합니다/);
console.log("6 번역 초안 OK:", f6.data.match(MARK("번역"))[0]);

// 7) 원문 그대로 + 외국어 제목 → 한국어 별칭 (구글 번역이라 별칭만 확인 대기)
const f7 = await plugin.scrap("https://www.4gamer.net/games/898/G089833/20251205029/", "스크랩", []);
assert.match(f7.data, /^---\nurl: \S+\naliases:\n  - ".*[가-힯].*"\n/);
assert.match(f7.data, /^# ［インタビュー］/m);
assert.match(f7.data, MARK("별칭"));
console.log("7 원문+별칭 OK:", f7.data.match(/aliases:\n  - (.*)/)[1]);

// 8) 한국어 기사 요약 + 번역 요청: 번역은 건너뛰고 핵심 문장 목록, 알림에 알려 줌
const f8 = await plugin.scrap("https://www.yna.co.kr/view/AKR20260708118151008", "스크랩", [], { translate: true, summary: true });
const bullets = f8.data.split("\n").filter((l) => l.startsWith("- "));
assert.ok(bullets.length >= 3 && bullets.length <= 6, `요약 항목 ${bullets.length}개`);
assert.ok(f8.data.length < 1500);
assert.match(f8.data, MARK("요약"));
console.log(`8 요약 OK: 항목 ${bullets.length}개 /`, mock.notices.at(-1).replace(/\n/g, " / "));

// 9) 주소로 부르기: 번역+요약 (일본어 기사)
await plugin.protocol({ action: "scrap", url: "https://www.famitsu.com/article/202607/82197", translate: "1", summary: "1" });
await new Promise((r) => setTimeout(r, 15000));
const f9 = [...vault.files.values()].find((f) => /famitsu/.test(f.data || "") && f.path.endsWith(".md"));
assert.ok(f9 && /^# .*[가-힯]/m.test(f9.data), "한국어 제목으로 저장되어야 함");
assert.ok(f9.data.split("\n").filter((l) => l.startsWith("- ")).length >= 3);
assert.match(f9.data, MARK("번역·요약"));
console.log("9 주소 호출 번역+요약 OK:", f9.path);
console.log("열린 노트:", opened);

// ---------- PC에서 Claude가 마무리 (가짜 Claude로 흐름만 검사, 실제 Claude는 plugin-desktop.mjs) ----------
const calls = [];
let fixedLine = "";
const fakeClaude = async (prompt) => {
  calls.push(prompt);
  if (/제목을 한국어로 옮긴다/.test(prompt)) return "젤다 무쌍 봉인전기 인터뷰";
  if (/요약한다/.test(prompt)) return "# 미야모토 시게루 인터뷰\n\n게임을 일상으로 만들고 싶다는 이야기다.\n\n- 첫째 항목이다.\n- 둘째 항목이다.\n- 셋째 항목이다.";
  // 번역 확인: 자리표시 없는 첫 줄을 고친다 (원래 줄의 절반보다 짧으면 내용을 빠뜨린 것으로 보고 버리므로 길이는 비슷하게)
  const item = [...prompt.matchAll(/^\[(\d+)\]\n원문: .*\n번역: (.*)$/gm)].find((m) => m[1] !== "0" && !m[2].includes("⟦"));
  fixedLine = `${item[2]} (Claude가 고친 줄)`;
  return `[0] 이상한 언어들\n[${item[1]}] ${fixedLine}\n[999] 없는 줄은 무시된다`;
};
plugin.claude = () => fakeClaude;
// 확인 기록은 PC만 쓴다
mock.Platform.isDesktopApp = true;
const DONE = (head, tail = "") => new RegExp(`^Claude: "${head} · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d${tail}"$`, "m");
const logText = () => vault.getAbstractFileByPath("스크랩/Claude 확인 기록.md")?.data || "";
const entryOf = (name) => logText().split(/\n(?=### )/).find((e) => e.startsWith("### ") && e.includes(`[[${name}]]`)) || "";

// 9-1) 기록 노트 맨 위에 아직 확인 대기인 노트 목록
await plugin.writeLog(null);
const waiting = logText().split("## 기록")[0];
assert.ok(waiting.includes("- [[이상한 언어]] — 번역 확인") && waiting.includes("— 별칭 확인") && waiting.includes("— 요약"), waiting);
console.log("9-1 확인 대기 목록 OK");

// 10) 번역 초안 → 원문을 다시 받아 대조, 고친 줄 반영, 제목이 바뀌면 파일 이름도
assert.equal(await plugin.finishNote(f6), "done");
assert.equal(f6.path, "스크랩/이상한 언어들.md");
assert.match(f6.data, /^# 이상한 언어들\n/m);
assert.ok(f6.data.includes(fixedLine) && !/확인 대기/.test(f6.data), f6.data.slice(0, 300));
// 노트에는 언제 확인했고 몇 줄 고쳤는지, 기록에는 고친 줄의 전후
assert.match(f6.data, DONE("번역 확인 완료", " · \\d+줄 중 2줄 고침"));
const e6 = entryOf("이상한 언어들");
assert.match(e6, /^번역 확인 완료 · \d+줄 중 2줄 고침 · 대기 초안 마무리$/m);
assert.ok(e6.includes("> [!example]- 고친 줄 2개") && e6.includes("> ~~이상한 언어~~\n> 이상한 언어들") && e6.includes(`> ${fixedLine.replace(/^[-#>\s]+/, "")}`), e6);
assert.ok(!logText().split("## 기록")[0].includes("[[이상한 언어"), "마무리한 노트는 확인 대기 목록에서 빠져야 함");
assert.ok(!f6.data.includes("weird-languages-5.gif"));
console.log("10 번역 마무리 OK:", f6.path);

// 11) 별칭만 확인 대기 → 원문 다시 받지 않고 별칭만 바꾼다
const before7 = f7.data;
const afterFm = (s) => s.slice(s.indexOf("\n---\n", 4));
assert.equal(await plugin.finishNote(f7), "done");
assert.match(f7.data, /^---\nurl: \S+\naliases:\n  - "젤다 무쌍 봉인전기 인터뷰"\n/);
assert.match(f7.data, DONE("별칭 확인 완료"));
assert.match(entryOf(f7.basename), /^- 별칭: .+ → 젤다 무쌍 봉인전기 인터뷰$/m);
assert.equal(afterFm(f7.data), afterFm(before7), "본문은 그대로여야 함");
console.log("11 별칭 마무리 OK");

// 12) 휴대폰에서 고친 노트는 건너뛰고, '이 노트 Claude로 마무리'(force)는 덮어쓴다
f9.data += "\n내 메모\n";
assert.equal(await plugin.finishNote(f9), "edited");
assert.match(f9.data, MARK("번역·요약"));
assert.equal(await plugin.finishNote(f9, { force: true }), "done");
assert.ok(!/내 메모|확인 대기/m.test(f9.data) && /^- 셋째 항목이다\.$/m.test(f9.data));
assert.match(f9.data, DONE("번역·요약 완료"));
assert.ok(entryOf(f9.basename).includes("> [!example]- 바꾸기 전 초안"), entryOf(f9.basename));
console.log("12 고친 노트 건너뛰기/덮어쓰기 OK:", f9.path);

// 13) Claude가 거절하면 표시만 지우고 내용은 그대로 둔다 (줄 처리 경로)
const body13 = "본문이다.\n";
const fm13 = { title: "Weird Languages", body: body13, aliases: ["이상한 언어"] };
const f13 = await vault.create(
  "스크랩/Weird Languages.md",
  `---\nurl: https://paulgraham.com/weird.html\naliases:\n  - "이상한 언어"\n${markerLine({ alias: true }, draftHash(fm13, { alias: true }))}\n---\n# Weird Languages\n\n${body13}`
);
plugin.claude = () => async () => "No.";
plugin.pending.add(f13.path);
await plugin.runPending();
assert.ok(!/확인 대기/.test(f13.data) && f13.data.includes('  - "이상한 언어"'), f13.data);
assert.match(f13.data, /^Claude: "별칭 확인 못 함 · .+"$/m);
assert.match(entryOf("Weird Languages"), /^별칭 확인 못 함 · /m);
// 휴대폰에서 고친 노트를 건너뛴 것도 기록에 남는다
const f14 = await vault.create("스크랩/고친 초안.md", f9.data.replace(/^Claude: .*$/m, markerLine({ translate: true }, "00000000")));
plugin.pending.add(f14.path);
await plugin.runPending();
assert.match(entryOf("고친 초안"), /^번역 확인 건너뜀 · /m);
assert.ok(logText().split("## 기록")[0].includes("- [[고친 초안]] — 번역 확인"));
mock.Platform.isDesktopApp = false;
console.log(logText().slice(0, 1500));
console.log("13 거절 시 표시만 지움 OK:", mock.notices.at(-1));

// 14) Remotely Save 자동 동기화 알림: 기본은 휴대폰·태블릿만, 문장 끝에 (링크 스크랩)
{
  const original = () => {};
  const rs = { settings: { serviceType: "onedrive" }, isSyncing: false, updateLastSyncMsg: original };
  const app2 = mock.makeApp(new mock.Vault());
  app2.plugins = { plugins: { "remotely-save": rs } };
  let ready = () => {};
  app2.workspace.onLayoutReady = (fn) => (ready = fn);
  const p = new LinkScrapPlugin(app2);
  await p.onload();
  assert.notEqual(rs.updateLastSyncMsg, original);
  assert.equal(p.settings.syncNotice, "mobile");
  const sync = (source) => {
    rs.updateLastSyncMsg(source, "syncing", -1, -1);
    rs.updateLastSyncMsg(source, "not_syncing", Date.now(), null);
  };
  const count = mock.notices.length;
  sync("auto_once_init"); // PC에서는 조용
  assert.equal(mock.notices.length, count);
  mock.Platform.isMobile = true;
  sync("auto_once_init");
  assert.deepEqual(mock.notices.slice(count), ["1/2 Remotely Save starts running (onedrive) (링크 스크랩)", "2/2 Remotely Save finished! (링크 스크랩)"]);
  sync("auto_sync_on_save");
  assert.equal(mock.notices.at(-1), "2/2 Remotely Save finished! (링크 스크랩)");
  assert.equal(mock.notices.length, count + 3);
  p.settings.syncNotice = "off";
  sync("auto");
  assert.equal(mock.notices.length, count + 3);
  mock.Platform.isMobile = false;
  p.settings.syncNotice = "all";
  sync("auto_sync_on_save");
  assert.equal(mock.notices.length, count + 4);
  // 화면이 준비되면 3초마다 다시 연결을 확인하고, 플러그인을 끄면 멈추고 원래 함수로 되돌린다
  ready();
  assert.ok(p.syncTimer);
  p.onunload();
  assert.equal(rs.updateLastSyncMsg, original);
  sync("auto");
  assert.equal(mock.notices.length, count + 4);
}
console.log("14 동기화 알림 OK:", mock.notices.at(-1));

// 15) PC: 플러그인 폴더에 새 버전이 설치되면 스스로 다시 불러온다. 휴대폰에서는 하지 않는다
{
  const make = async (desktop, saved) => {
    const files = { main: 100, manifest: 100 };
    const calls = [];
    const stats = [];
    const app3 = mock.makeApp(new mock.Vault());
    app3.vault.adapter = { stat: async (p) => (stats.push(p), { mtime: p.endsWith("main.js") ? files.main : files.manifest, size: 1 }) };
    app3.plugins = { plugins: {}, disablePlugin: async (id) => calls.push("off " + id), loadManifests: async () => calls.push("manifests"), enablePlugin: async (id) => calls.push("on " + id) };
    mock.Platform.isDesktopApp = desktop;
    const p = new LinkScrapPlugin(app3);
    p.manifest = { id: "link-scrap", version: "1.6.1", dir: ".obsidian/plugins/link-scrap" };
    const savedData = [];
    p.loadData = async () => saved;
    p.saveData = async (d) => savedData.push({ ...d });
    await p.onload();
    mock.Platform.isDesktopApp = false;
    return { p, files, calls, stats, savedData };
  };
  // PC: 불러온 버전을 적어 둔다 (처음에는 알림 없음)
  const a = await make(true, null);
  assert.deepEqual(a.stats, [".obsidian/plugins/link-scrap/main.js", ".obsidian/plugins/link-scrap/manifest.json"]);
  assert.equal(a.savedData.at(-1).loadedVersion, "1.6.1");
  await a.p.fileWatch.check();
  assert.deepEqual(a.calls, []);
  // 새 파일이 복사되면 다음다음 확인에서 껐다 켠다. Claude가 마무리하는 중이면 끝난 뒤에
  a.files.main = a.files.manifest = 200;
  a.p.pendingBusy = true;
  await a.p.fileWatch.check();
  await a.p.fileWatch.check();
  assert.deepEqual(a.calls, []);
  a.p.pendingBusy = false;
  await a.p.fileWatch.check();
  assert.deepEqual(a.calls, ["off link-scrap", "manifests", "on link-scrap"]);
  // 버전이 바뀌어 불리면 알린다. 같은 버전이면 다시 적지도 알리지도 않는다
  const n = mock.notices.length;
  const b = await make(true, { settingsVersion: 2, loadedVersion: "1.6.0" });
  assert.equal(mock.notices.at(-1), "링크 스크랩 1.6.0 → 1.6.1 업데이트");
  assert.equal(b.savedData.at(-1).loadedVersion, "1.6.1");
  const c = await make(true, { settingsVersion: 2, loadedVersion: "1.6.1" });
  assert.equal(c.savedData.length, 0);
  assert.equal(mock.notices.length, n + 1);
  // 휴대폰: 파일을 보지 않는다
  const d = await make(false, { settingsVersion: 2 });
  assert.equal(d.p.fileWatch, undefined);
  assert.deepEqual(d.stats, []);
  assert.equal(d.savedData.length, 0);
}
console.log("15 PC 자동 다시 불러오기 OK:", mock.notices.at(-1));

// 16) 휴대폰에서 구글 번역이 막히면(429) 원문으로 저장하되 확인 대기 표시 → PC가 번역 초안부터 만들어 마무리
{
  const realFetch = globalThis.fetch;
  let blocked = 0;
  globalThis.fetch = (url, opts) => (String(url).includes("translate.googleapis") ? (blocked++, Promise.resolve(new Response("", { status: 429 }))) : realFetch(url, opts));
  plugin.claude = () => undefined;
  mock.Platform.isDesktopApp = false;
  const f = await plugin.scrap("https://paulgraham.com/useful.html", "스크랩", [], { translate: true, summary: false });
  globalThis.fetch = realFetch;
  assert.ok(blocked >= 3, "다시 보내기까지 해야 함");
  assert.match(f.data, MARK("번역"));
  assert.ok(!/[가-힯]/.test(f.data.split("\n---\n")[1] || ""), "본문은 원문 그대로");
  assert.match(mock.notices.at(-1), /HTTP 429.*원문으로 저장했습니다[\s\S]*PC 옵시디언에서 Claude가 마무리합니다/);
  // PC: 구글이 풀렸으면 번역 초안을 만들고 Claude가 확인
  plugin.claude = () => fakeClaude;
  mock.Platform.isDesktopApp = true;
  assert.equal(await plugin.finishNote(f), "done");
  assert.ok(!/확인 대기/.test(f.data) && /^# .*[가-힯]/m.test(f.data), f.data.slice(0, 300));
  assert.match(f.data, DONE("번역 확인 완료", " · \\d+줄 중 \\d+줄 고침"));
  mock.Platform.isDesktopApp = false;
}
console.log("16 구글 막힘 → 원문 + 확인 대기 → PC 마무리 OK:", mock.notices.at(-1));

// 17) 사용자 최종 승인: Claude를 거친 번역·요약 노트에만 '승인: false', 승인 목록(Bases)과 승인 명령
{
  const fmOf = (f) => f.data.split("\n---\n")[0];
  assert.match(fmOf(f6), /^승인: false$/m); // 번역 마무리
  assert.match(fmOf(f9), /^승인: false$/m); // 요약 마무리(덮어쓰기)
  assert.ok(!/^승인:/m.test(fmOf(f7)), "별칭만 고친 노트는 승인 대상이 아님");
  assert.equal((fmOf(f6).match(/^승인:/gm) || []).length, 1);
  // 승인 목록 열기: 없으면 Bases 파일을 만들고 연다
  await plugin.openReview();
  const base = vault.getAbstractFileByPath("스크랩/스크랩 승인.base");
  assert.ok(base && /note\["승인"\] == false/.test(base.data) && /name: Claude 확인 대기/.test(base.data), base?.data);
  assert.equal(opened.at(-1), "스크랩/스크랩 승인.base");
  // 이 스크랩 승인: 승인 대기 노트에서만 보이고, 누르면 true
  const cmd = plugin.commands.find((c) => c.id === "approve-this");
  app.workspace.getActiveFile = () => f6;
  app.fileManager.processFrontMatter = async (file, fn) => {
    const fm = {};
    fn(fm);
    file.data = file.data.replace(/^승인: .*$/m, `승인: ${fm["승인"]}`);
  };
  assert.equal(cmd.checkCallback(true), true);
  cmd.checkCallback(false);
  await new Promise((r) => setTimeout(r, 10));
  assert.match(fmOf(f6), /^승인: true$/m);
  assert.equal(cmd.checkCallback(true), false);
  app.workspace.getActiveFile = () => f7;
  assert.equal(cmd.checkCallback(true), false);
}
console.log("17 사용자 승인 OK:", mock.notices.at(-1));

// 18) 번역 용어집 노트: 없으면 명령이 틀을 만들고, 플러그인이 읽어 쓴다
{
  assert.deepEqual(await plugin.terms(), []);
  await plugin.openTerms();
  const note = vault.getAbstractFileByPath("스크랩/번역 용어집.md");
  assert.ok(note && note.data.includes("- カービィ → 커비"), note?.data);
  assert.equal(opened.at(-1), "스크랩/번역 용어집.md");
  assert.deepEqual((await plugin.terms()).map((t) => t.join("→")), ["カービィ→커비", "카비→커비"]);
}
console.log("18 번역 용어집 OK");

// 19) PC 번역 전에 한국 정식 명칭 찾기: Claude가 뽑은 이름 → 위키백과(실제) → Claude 맥락 확인·검색 → 용어집 자동 칸
{
  const asked = [];
  const run = async (prompt, opts = {}) => {
    asked.push({ prompt, tools: opts.tools || "" });
    if (/원문 표기 그대로 뽑는다/.test(prompt)) return "カービィ\nパドック\nシティトライアル";
    return "カービィ → 커비 | 위키백과\nパドック → 없음\nシティトライアル → 시티 트라이얼 | https://www.nintendo.com/kr/games/switch2/aaaba/products/soft.html";
  };
  const a = { title: "『カービィのエアライダー』の最適化", markdown: "カービィがパドックに集まる。シティトライアルでは描画負荷が高まります。".repeat(3) };
  const before = await plugin.terms();
  const terms = await plugin.termsFor(a, run);
  const note = vault.getAbstractFileByPath("스크랩/번역 용어집.md").data;
  assert.ok(note.includes("## 자동으로 찾은 표기") && note.includes("- シティトライアル → 시티 트라이얼 %% 웹 검색 https://www.nintendo.com/kr/"), note);
  assert.ok(!note.includes("예시장") && !/パドック/.test(note), "맥락이 다른 위키백과 표기는 넣지 않음");
  assert.equal(note.match(/カービィ →/g).length, 1, "이미 있는 원어는 다시 넣지 않음");
  assert.ok(terms.length === before.length + 1 && terms.some(([f, t]) => f === "シティトライアル" && t === "시티 트라이얼"));
  assert.equal(asked.find((x) => x.tools).tools, "WebSearch");
  assert.ok(asked.find((x) => x.tools).prompt.includes("글 제목: 『カービィのエアライダー』の最適化"));
  // 한국어·영어 글이면 찾지 않는다
  asked.length = 0;
  await plugin.termsFor({ title: "한국어 글", markdown: "한국어로 쓴 글이라 찾을 것이 없다." }, run);
  assert.equal(asked.length, 0);
}
console.log("19 한국 정식 명칭 찾기 OK");

// 20) 이미 만든 노트의 고유명사 표기를 정식 표기로 맞추기 (영어 글)
{
  mock.Platform.isDesktopApp = true;
  const run = async (prompt, opts = {}) => {
    if (/원문 표기 그대로 뽑는다/.test(prompt)) return "Bombchu\nGold Skulltula";
    if (opts.tools) return "Bombchu → 봄추 | https://www.nintendo.com/kr/x\nGold Skulltula → 황금 스타르츄라 | https://www.nintendo.com/kr/y";
    if (/노트에서 <표기>의 대상을/.test(prompt)) return "봄츄 → 봄추\n황금 스컬트라 → 황금 스타르츄라\n없는말 → 봄추\n볼링 → 공굴리기";
    return "없음";
  };
  plugin.claude = () => run;
  const realFetch = plugin.fetchArticle;
  plugin.fetchArticle = async () => ({ kind: "article", title: "Ocarina remake: Bombchu bowling", markdown: "The Bombchu Bowling owner. Collect 100 Gold Skulltula tokens." });
  const f = await vault.create("스크랩/게임/봄츄 볼링 이야기.md", `---\nurl: https://example.com/zelda\nClaude: "번역·요약 완료 · 2026-11-18 23:59"\n승인: true\n---\n# 봄츄 볼링 이야기\n\n- 봄츄 볼링 주인의 근황.\n- 황금 스컬트라 100마리를 모은다. 봄츄를 준다.\n`);
  // 근거 페이지에 그 표기가 실제로 있어야 받으므로, 근거 주소의 내용을 흉내 낸다
  const netFetch = globalThis.fetch;
  globalThis.fetch = (url, o) => (/nintendo\.com\/kr\/[xy]$/.test(String(url)) ? Promise.resolve(new Response("<p>봄추 · 황금 스타르츄라</p>", { status: 200 })) : netFetch(url, o));
  const pairs = await plugin.recheckTerms(f);
  globalThis.fetch = netFetch;
  plugin.fetchArticle = realFetch;
  assert.deepEqual(pairs, [["황금 스컬트라", "황금 스타르츄라", 1], ["봄츄", "봄추", 3]]);
  assert.equal(f.path, "스크랩/게임/봄추 볼링 이야기.md");
  assert.ok(/^# 봄추 볼링 이야기$/m.test(f.data) && f.data.includes("황금 스타르츄라 100마리") && !f.data.includes("봄츄") && f.data.includes("볼링"), f.data);
  assert.match(f.data, /^승인: false$/m); // 내용이 바뀌었으니 다시 승인
  assert.match(f.data, /^Claude: "번역·요약 완료/m);
  const e = entryOf("봄추 볼링 이야기");
  assert.ok(e.includes("고유명사 표기 맞춤 · 2가지") && e.includes("- ~~봄츄~~ → 봄추 (3곳)"), e);
  mock.Platform.isDesktopApp = false;
}
console.log("20 노트 고유명사 맞추기 OK");
