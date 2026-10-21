// URL 하나를 받아 {title, url, markdown, ...}을 만드는 전체 흐름.
// 네트워크·HTML 파서·마크다운 변환기는 주입받는다 (옵시디언: requestUrl/DOMParser/htmlToMarkdown, 테스트: fetch/jsdom/turndown).
import { extractArticle, decodeHtml, rewriteFetchUrl, apiOverride, tidyMarkdown, userAgentFor } from "./extract.js";

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|igshid|sub_rt|ntype|cds|ref_src|si)$/i;
export const BLOCKED_TITLE = /^(Just a moment|Attention Required|잠시만 기다리십시오|잠시만 기다려)/i;
const SHORT_HOSTS = /^(naver\.me|bit\.ly|t\.co|goo\.gl|han\.gl|me2\.do|url\.kr|vo\.la|buly\.kr|link\.coupang\.com|youtu\.be|a\.co|amzn\.to)$/i;

// 공유 시트로 들어온 "제목 https://..." 같은 글에서 첫 번째 URL만 꺼낸다
export function findUrl(text) {
  const m = (text || "").match(/https?:\/\/[^\s<>"'`]+/i);
  if (!m) return null;
  return m[0].replace(/[)\]}.,!?。、」』]+$/, "");
}

// 저장용 주소: 추적용 파라미터와 #google_vignette 같은 꼬리를 떼어낸다
export function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    [...u.searchParams.keys()].forEach((k) => TRACKING_PARAMS.test(k) && u.searchParams.delete(k));
    if (/^#(google_vignette|none)?$/.test(u.hash)) u.hash = "";
    return u.href;
  } catch {
    return raw;
  }
}

function canonicalOf(doc, fallback) {
  const el =
    doc.querySelector('link[rel="canonical"]') ||
    doc.querySelector('meta[property="og:url"]');
  const v = el && (el.getAttribute("href") || el.getAttribute("content"));
  try {
    return v ? new URL(v, fallback).href : fallback;
  } catch {
    return fallback;
  }
}

/**
 * @param {string} input  사용자가 준 링크(또는 링크가 섞인 글)
 * @param {{request:(url:string, userAgent:string)=>Promise<{status:number, contentType:string, body:ArrayBuffer}>,
 *          parseHtml:(html:string, url:string)=>Document,
 *          toMarkdown:(html:string)=>string,
 *          renderPage?:(url:string)=>Promise<string>}} io  renderPage: 차단됐을 때 브라우저 엔진으로 연 HTML (선택)
 */
export async function scrapUrl(input, io) {
  const original = findUrl(input);
  if (!original) throw new Error("링크를 찾지 못했습니다");

  const api = apiOverride(original);
  if (api) {
    const res = await io.request(api.url, userAgentFor(api.url));
    const a = res.status < 400 ? api.parse(new TextDecoder().decode(res.body)) : null;
    if (a) {
      return { kind: "article", url: cleanUrl(original), title: a.title, markdown: tidyMarkdown(io.toMarkdown(a.html), a.title), fallback: false };
    }
  }

  let fetchUrl = rewriteFetchUrl(original);
  let res = await io.request(fetchUrl, userAgentFor(fetchUrl));

  if (/application\/pdf/i.test(res.contentType) || /\.pdf($|\?)/i.test(fetchUrl)) {
    const name = decodeURIComponent(new URL(fetchUrl).pathname.split("/").pop() || "document.pdf");
    return { kind: "pdf", url: cleanUrl(original), title: name.replace(/\.pdf$/i, ""), body: res.body };
  }

  let html = decodeHtml(res.body, res.contentType);
  let doc = io.parseHtml(html, fetchUrl);
  // 짧은 주소(naver.me 등)는 리다이렉트된 실제 주소를 canonical에서 알아낸다
  let pageUrl = canonicalOf(doc, fetchUrl);
  const rewritten = rewriteFetchUrl(pageUrl);
  if (rewritten !== pageUrl && rewritten !== fetchUrl) {
    res = await io.request(rewritten, userAgentFor(rewritten));
    html = decodeHtml(res.body, res.contentType);
    doc = io.parseHtml(html, rewritten);
    pageUrl = rewritten;
  }
  // 네이버 블로그 PC 화면처럼 본문이 iframe 안에 있는 경우
  const frame = doc.querySelector("iframe#mainFrame");
  if (frame && frame.getAttribute("src")) {
    const inner = rewriteFetchUrl(new URL(frame.getAttribute("src"), pageUrl).href);
    res = await io.request(inner, userAgentFor(inner));
    doc = io.parseHtml(decodeHtml(res.body, res.contentType), inner);
    pageUrl = inner;
  }

  if (res.status >= 400 || BLOCKED_TITLE.test(doc.title)) {
    // Cloudflare 등이 막으면, 가능한 환경(PC)에서는 실제 브라우저 엔진으로 열어 본다
    const rendered = io.renderPage ? await io.renderPage(pageUrl).catch(() => null) : null;
    if (!rendered) throw new Error(`사이트가 접속을 막았습니다 (HTTP ${res.status})`);
    doc = io.parseHtml(rendered, pageUrl);
  }

  const a = extractArticle(doc, pageUrl);
  const shortLink = SHORT_HOSTS.test(new URL(original).hostname);
  return {
    kind: "article",
    url: cleanUrl(shortLink ? pageUrl : original),
    title: a.title,
    markdown: tidyMarkdown(io.toMarkdown(a.html || ""), a.title),
    fallback: a.fallback,
  };
}
