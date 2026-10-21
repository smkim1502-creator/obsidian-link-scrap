// 빌드: node build.mjs          → dist/main.js
//       node build.mjs --install → Vault 플러그인 폴더에도 복사
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const VAULT_PLUGIN_DIR = "C:/Users/sec/Obsidian Vault/Second Brain/.obsidian/plugins/link-scrap";

await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "cjs",
  target: "es2020", // 모바일 WebView 호환
  platform: "browser",
  external: ["obsidian", "electron"],
  outfile: "dist/main.js",
  logLevel: "info",
});
fs.copyFileSync("manifest.json", "dist/manifest.json");

if (process.argv.includes("--install")) {
  fs.mkdirSync(VAULT_PLUGIN_DIR, { recursive: true });
  for (const f of ["main.js", "manifest.json"]) fs.copyFileSync(path.join("dist", f), path.join(VAULT_PLUGIN_DIR, f));
  console.log("설치:", VAULT_PLUGIN_DIR);
}
