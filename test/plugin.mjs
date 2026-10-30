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
buttonsOf(quick)[1].click();
assert.ok(quick.contentEl.textContent.includes("https://example.com/b") && picked.summary && !picked.translate);
console.log("2-1 저장 형태 버튼 OK");

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
