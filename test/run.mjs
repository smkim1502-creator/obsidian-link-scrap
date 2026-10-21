// 실제 URL로 추출 결과를 확인한다: node test/run.mjs [url ...]
// 플러그인과 같은 scrapUrl()을 쓰되, 옵시디언 API 대신 fetch/jsdom/turndown을 주입한다.
// (옵시디언의 htmlToMarkdown과 turndown은 표·서식이 약간 다를 수 있다)
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import fs from "node:fs";
import { scrapUrl } from "../src/scrap.js";
import { safeFileName } from "../src/extract.js";

const DEFAULT_URLS = [
  "https://m.dcinside.com/board/thesingularity/1407506",
  "https://gall.dcinside.com/mgallery/board/view/?id=thesingularity&no=1407506",
  "https://brunch.co.kr/@hiclemi/152",
  "https://news.hada.io/topic?id=29185",
  "https://n.news.naver.com/article/015/0005317441?ntype=RANKING&cds=news_my_20s",
  "https://note.com/nokiainoue/n/n0b13d6ef51c7?sub_rt=share_pw",
  "https://ma-tsu-si-ba.hatenablog.com/entry/2025/12/18/221000",
  "https://www.famitsu.com/article/202607/82197#google_vignette",
  "https://www.4gamer.net/games/898/G089833/20251205029/",
  "https://contents.tossinvest.com/article/digest/50561?utm_source=referral_button_digest_content",
  "https://www.yna.co.kr/view/AKR20260708118151008?input=yna_newsletter",
  "https://www.hankyung.com/article/2026090173701#google_vignette",
  "https://arca.live/b/aihomelab/185810092",
  "https://m.ruliweb.com/nin/board/300004/read/2358850?page=1",
  "공유 텍스트에 섞인 링크 https://story.pay.naver.com/content/1965_29_C2 입니다",
  "https://www.nintendo.co.jp/ir/pdf/2026/qa2606.pdf",
];

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
td.use(gfm);
const io = {
  request: async (url, userAgent) => {
    const res = await fetch(url, { headers: { "User-Agent": userAgent, "Accept-Language": "ko-KR,ko;q=0.9,ja;q=0.8,en;q=0.7" } });
    return { status: res.status, contentType: res.headers.get("content-type") || "", body: await res.arrayBuffer() };
  },
  parseHtml: (html, url) => new JSDOM(html, { url }).window.document,
  toMarkdown: (html) => td.turndown(html),
};

const outDir = new URL("./tmp_out/", import.meta.url);
fs.mkdirSync(outDir, { recursive: true });

for (const input of process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS) {
  try {
    const r = await scrapUrl(input, io);
    if (r.kind === "pdf") {
      console.log(`PDF    ${String(r.body.byteLength).padStart(7)}B  ${r.title}  <- ${r.url}`);
      continue;
    }
    fs.writeFileSync(new URL(safeFileName(r.title) + ".md", outDir), `url: ${r.url}\n# ${r.title}\n\n${r.markdown}`);
    console.log(`${r.fallback ? "요약만" : "본문  "} ${String(r.markdown.length).padStart(6)}자  ${r.title}  <- ${r.url}`);
  } catch (e) {
    console.log(`실패   ${input}: ${e.message}`);
  }
}
