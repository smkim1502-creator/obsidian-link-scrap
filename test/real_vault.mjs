// 실제 Vault 노트를 가짜 옵시디언에 읽어 넣고 새 글을 스크랩해, 자동 태그·관련 노트가 어떻게 달리는지 본다.
// 실제 Vault는 읽기만 한다 (저장은 메모리에서만).  node test/real_vault.mjs "폴더" url [url …]
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const VAULT = "C:/Users/sec/Obsidian Vault/Second Brain";
const [folder = "스크랩", ...urls] = process.argv.slice(2);

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

const vault = new mock.Vault();
function load(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    const rel = path.relative(VAULT, p).replace(/\\/g, "/");
    if (e.isDirectory()) {
      vault.createFolder(rel);
      load(p);
    } else if (e.name.endsWith(".md")) vault.create(rel, fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n"));
  }
}
load(VAULT);

// 테스트용 간이 frontmatter 파서 (url, 목록형 tags/aliases)
function frontmatter(text) {
  const m = typeof text === "string" && text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return undefined;
  const fm = {};
  let key = null;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      fm[key] = kv[2] ? kv[2].replace(/^["']|["']$/g, "") : [];
    } else if (key && /^\s+-\s/.test(line) && Array.isArray(fm[key])) fm[key].push(line.replace(/^\s+-\s*/, "").replace(/^["']|["']$/g, ""));
  }
  return fm;
}
const app = {
  vault,
  metadataCache: {
    getFileCache: (f) => ({ frontmatter: frontmatter(f.data) }),
    fileToLinktext: (f) => {
      const same = vault.getMarkdownFiles().filter((o) => o.basename === f.basename);
      return same.length > 1 ? f.path.replace(/\.md$/, "") : f.basename;
    },
  },
  workspace: { getLeaf: () => ({ openFile: async () => {} }) },
};
const plugin = new LinkScrapPlugin(app);
await plugin.onload();
console.log(`Vault 노트 ${vault.getMarkdownFiles().length}개 로드`);

for (const url of urls) {
  const t0 = Date.now();
  const f = await plugin.scrap(url, folder, []);
  if (!f) {
    console.log(`\n실패 ${url}: ${mock.notices.at(-1)}`);
    continue;
  }
  console.log(`\n=== ${f.path}  (${Date.now() - t0}ms)`);
  console.log(f.data.split("\n").slice(0, 10).join("\n").slice(0, 600));
  console.log("알림:", mock.notices.at(-1).replace(/\n/g, " / "));
}

// 디버그: 기준 없이 상위 후보 점수 보기 (DEBUG=1)
if (process.env.DEBUG) {
  const { suggest } = await import("../src/related.js");
  const idx = await plugin.getIndex();
  for (const f of vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder + "/") && !fs.existsSync(path.join(VAULT, f.path)))) {
    const s = suggest(idx, { title: f.basename, markdown: f.data, folder, excludePath: f.path }, { minScore: 0, maxRelated: 6, excludeFolders: ["스크랩", "클로드 코드 프로젝트", "해결해야 할 문제"] });
    console.log(`\n[후보] ${f.basename.slice(0, 30)}\n  ` + s.related.map((r) => `${r.title}(${r.score}${r.mentioned ? ",언급" : ""})`).join("\n  "));
  }
}
