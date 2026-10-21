// 플러그인 코드 경로 전체를 가짜 옵시디언 환경에서 실행: node test/plugin.mjs
import esbuild from "esbuild";
import assert from "node:assert/strict";

await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "esm",
  platform: "node",
  alias: { obsidian: "./test/obsidian-mock.js" },
  external: ["jsdom", "turndown", "turndown-plugin-gfm"],
  outfile: "test/tmp_build/main.mjs",
  logLevel: "warning",
});
const mock = await import("./obsidian-mock.js");
const { default: LinkScrapPlugin } = await import("./tmp_build/main.mjs");

const vault = new mock.Vault();
await vault.createFolder("스크랩");
await vault.createFolder("스크랩/AI");
const opened = [];
const app = {
  vault,
  metadataCache: {
    // 테스트용: frontmatter의 url 줄만 읽는다
    getFileCache: (f) => {
      const m = typeof f.data === "string" && f.data.match(/^---\nurl: "?([^"\n]+)"?\n/);
      return m ? { frontmatter: { url: m[1] } } : {};
    },
  },
  workspace: { getLeaf: () => ({ openFile: async (f) => opened.push(f.path) }) },
};
const plugin = new LinkScrapPlugin(app);
await plugin.onload();

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

// 3) 프로토콜 핸들러 + 이미지 Vault 저장 (디시 이미지)
plugin.settings.saveImages = true;
await plugin.protocol({ action: "scrap", url: "디시 글 https://m.dcinside.com/board/thesingularity/1407506", tags: "AI" });
await new Promise((r) => setTimeout(r, 15000));
const f3 = [...vault.files.values()].find((f) => f.path === "스크랩/AI/AI 수학 발전의 역사.md");
assert.ok(f3, "디시 글 노트가 마지막 폴더(스크랩/AI)에 저장되어야 함");
const imgs = [...vault.files.keys()].filter((p) => p.startsWith("_resources/스크랩/AI 수학 발전의 역사/"));
assert.ok(imgs.length > 0, "이미지가 저장되어야 함");
assert.ok(!/dcimg/.test(f3.data), "원격 이미지 주소가 남으면 안 됨");
console.log(`3 프로토콜+이미지 저장 OK: 이미지 ${imgs.length}개`, imgs.slice(0, 2));
console.log(f3.data.slice(0, 300));
plugin.settings.saveImages = false;

// 4) PDF
const f4 = await plugin.scrap("https://www.nintendo.co.jp/ir/pdf/2026/qa2606.pdf", "스크랩", []);
assert.ok(vault.files.has("스크랩/qa2606.pdf"));
assert.match(f4.data, /!\[\[qa2606\.pdf\]\]/);
console.log("4 PDF OK:", f4.path);

// 5) 실패 시 알림
await plugin.scrap("https://arca.live/b/aihomelab/185810092", "스크랩", []);
console.log("5 실패 알림:", mock.notices.at(-1));
console.log("열린 노트:", opened);
