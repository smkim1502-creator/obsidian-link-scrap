// 빌드한 dist/main.js를 PC 앱처럼(Claude Code 사용) 실행해 번역·요약·별칭을 확인한다: node build.mjs && node test/plugin-desktop.mjs
// 이 PC의 Claude Code를 실제로 부르므로 구독 사용량이 조금 든다.
import Module, { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";

const mock = await import("./obsidian-mock.js");
const desktop = { ...mock, Platform: { isMobile: false, isDesktopApp: true } };
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "obsidian" ? desktop : load.call(this, request, ...rest);
};
// package.json이 "type": "module"이라 .js는 ESM으로 읽히므로, 옵시디언처럼 CommonJS로 읽게 .cjs로 복사한다
fs.mkdirSync(new URL("./tmp_build/", import.meta.url), { recursive: true });
fs.copyFileSync(new URL("../dist/main.js", import.meta.url), new URL("./tmp_build/main-desktop.cjs", import.meta.url));
const { default: LinkScrapPlugin } = createRequire(import.meta.url)("./tmp_build/main-desktop.cjs");

const vault = new mock.Vault();
await vault.createFolder("스크랩");
const plugin = new LinkScrapPlugin(mock.makeApp(vault));
await plugin.onload();
plugin.settings.autoTags = plugin.settings.autoLinks = false;

const run = async (label, url, mode) => {
  const t0 = Date.now();
  const f = await plugin.scrap(url, "스크랩", [], mode);
  const notice = mock.notices.at(-1);
  assert.ok(f, notice);
  assert.ok(!/하지 못해|확인하지 못해/.test(notice), notice);
  assert.ok(!/확인 대기/.test(f.data), "PC에서 Claude가 마무리했으면 확인 대기 표시가 없어야 함");
  if (mode.translate || mode.summary) assert.match(f.data, /^Claude: ".*완료 · /m);
  console.log(`${label} ${((Date.now() - t0) / 1000).toFixed(1)}초  ${f.path}`);
  return f;
};

// 전문 번역: 구글 번역 초안을 Claude가 원문과 대조해 고친다
const a = await run("번역 전문", "https://paulgraham.com/weird.html", { translate: true, summary: false });
assert.match(a.data, /^# .*[가-힯]/m);
assert.ok(!a.data.includes("weird-languages-5.gif"), "이미지는 빼야 함");
assert.ok(!a.data.includes("⟦"));

const b = await run("원문 요약", "https://www.yna.co.kr/view/AKR20260708118151008", { translate: false, summary: true });
assert.ok(b.data.split("\n").filter((l) => l.startsWith("- ")).length >= 3);

const c = await run("원문+별칭", "https://note.com/nokiainoue/n/n0b13d6ef51c7", { translate: false, summary: false });
const alias = (c.data.match(/^aliases:\n  - (.*)$/m) || [])[1];
assert.ok(alias && /[가-힯]/.test(alias), c.data.slice(0, 200));
console.log("  별칭:", alias);

const d = await run("번역 요약", "https://ma-tsu-si-ba.hatenablog.com/entry/2025/12/18/221000", { translate: true, summary: true });
assert.match(d.data, /^# .*[가-힯]/m);
assert.ok(!/^aliases:/m.test(d.data));
console.log(d.data.slice(0, 700));

// 휴대폰 초안을 PC에서 마무리: Claude 없이 초안을 만들고(휴대폰과 같음) → finishNote
vault.files.delete(c.path); // 같은 글을 다시 스크랩하려고 원문 노트를 치운다
plugin.claude = () => undefined;
const e = await plugin.scrap("https://note.com/nokiainoue/n/n0b13d6ef51c7", "스크랩", [], { translate: true, summary: false });
delete plugin.claude;
assert.match(e.data, /^Claude: 번역 확인 대기 \([0-9a-f]{8}\)$/m);
const draft = e.data;
const t0 = Date.now();
assert.equal(await plugin.finishNote(e, { say: (m) => process.stdout.write(`  ${m}\n`) }), "done");
assert.match(e.data, /^Claude: "번역 확인 완료 · .* · \d+줄 중 \d+줄 고침"$/m);
const log = vault.getAbstractFileByPath("스크랩/Claude 확인 기록.md").data;
assert.ok(log.includes(`[[${e.basename}]]`) && log.includes("> [!example]- 고친 줄"), log.slice(0, 800));
const changed = draft.split("\n").filter((l) => l.trim() && !e.data.includes(l)).length;
assert.ok(changed > 0, "Claude가 고친 줄이 있어야 함");
console.log(`휴대폰 초안 마무리 ${((Date.now() - t0) / 1000).toFixed(1)}초  ${e.path}  (초안에서 바뀐 줄 ${changed}개)`);
console.log(e.data.slice(0, 700));
