// 번역·요약 결과를 실제 글로 확인한다 → test/tmp_out/transform/
//   node test/transform.mjs [--claude] [--model=haiku] [--mode=번역,요약,번역요약] [url …]
//   --claude: PC처럼 Claude Code로 마무리 (없으면 휴대폰처럼 초안만: 구글 번역 + 핵심 문장 고르기)
import fs from "node:fs";
import { createRequire } from "node:module";
import { scrapUrl } from "../src/scrap.js";
import { safeFileName } from "../src/extract.js";
import { transformArticle } from "../src/transform.js";
import { claudeRunner } from "../src/claude.js";
import { io } from "./node-io.mjs";

const DEFAULT_URLS = [
  "https://n.news.naver.com/article/015/0005317441",
  "https://www.yna.co.kr/view/AKR20260708118151008",
  "https://www.4gamer.net/games/898/G089833/20251205029/",
  "https://www.famitsu.com/article/202607/82197",
  "https://paulgraham.com/weird.html",
];
const MODES = { 번역: { translate: true, summary: false }, 요약: { translate: false, summary: true }, 번역요약: { translate: true, summary: true } };

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const urls = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const modes = (flags.mode || "번역,요약,번역요약").split(",");
const runClaude = "claude" in flags ? claudeRunner(createRequire(import.meta.url), { model: flags.model || "sonnet" }) : undefined;

const outDir = new URL("./tmp_out/transform/", import.meta.url);
fs.mkdirSync(outDir, { recursive: true });

for (const url of urls.length ? urls : DEFAULT_URLS) {
  let a;
  try {
    a = await scrapUrl(url, io);
  } catch (e) {
    console.log(`스크랩 실패 ${url}: ${e.message}`);
    continue;
  }
  for (const m of modes) {
    const t0 = Date.now();
    try {
      const r = await transformArticle(a, MODES[m], { post: io.post, runClaude });
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      if (!r) {
        console.log(`${m.padEnd(4)} 그대로     ${a.title}`);
        continue;
      }
      const engine = r.done ? "claude" : "draft";
      const name = `${m} ${engine} - ${safeFileName(r.title).slice(0, 60)}.md`;
      fs.writeFileSync(new URL(name, outDir), `url: ${a.url}\n원문 ${a.markdown.length}자\n# ${r.title}\n\n${r.markdown}`);
      const extra = r.fixes !== undefined ? ` (고친 줄 ${r.fixes}, ${r.parts}부분)` : "";
      console.log(`${m.padEnd(4)} ${engine.padEnd(6)} ${sec.padStart(5)}초 ${String(a.markdown.length).padStart(6)}자 → ${String(r.markdown.length).padStart(6)}자  ${r.title}${extra}${r.warning ? `  ⚠ ${r.warning}` : ""}`);
    } catch (e) {
      console.log(`${m.padEnd(4)} 실패 ${a.title}: ${e.message}`);
    }
  }
}
