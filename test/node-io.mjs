// 테스트용 io: 옵시디언 API 대신 fetch/jsdom/turndown (옵시디언의 htmlToMarkdown과 표·서식이 약간 다를 수 있다)
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
td.use(gfm);

export const io = {
  request: async (url, userAgent) => {
    const res = await fetch(url, { headers: { "User-Agent": userAgent, "Accept-Language": "ko-KR,ko;q=0.9,ja;q=0.8,en;q=0.7" } });
    return { status: res.status, contentType: res.headers.get("content-type") || "", body: await res.arrayBuffer() };
  },
  post: async (url, body, contentType) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": contentType }, body });
    return { status: res.status, text: await res.text() };
  },
  parseHtml: (html, url) => new JSDOM(html, { url }).window.document,
  toMarkdown: (html) => td.turndown(html),
};
