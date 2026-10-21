// 웹 페이지 HTML에서 제목과 본문을 뽑아내는 순수 로직.
// 옵시디언 API에 의존하지 않으므로 Node(jsdom)에서도 그대로 테스트할 수 있다.
import { Readability } from "@mozilla/readability";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

// 브라우저 UA를 보내면 카카오 자동 로그인으로 끝없이 리다이렉트되는 사이트
const SIMPLE_UA = "Mozilla/5.0 (compatible; LinkScrap/1.0)";
const UA_OVERRIDES = [/^brunch.co.kr$/];

export function userAgentFor(url) {
  try {
    const host = new URL(url).hostname;
    return UA_OVERRIDES.some((r) => r.test(host)) ? SIMPLE_UA : USER_AGENT;
  } catch {
    return USER_AGENT;
  }
}

// 사이트별 전용 규칙. Readability가 놓치거나 잡동사니를 섞는 국내 사이트 위주.
const SITE_RULES = [
  {
    host: /(^|\.)dcinside\.com$/,
    title: [".gallview-tit-box .tit", ".title_subject"],
    content: [".thum-txtin", ".write_div"],
    remove: [".adv-groupin", ".adv-groupno", ".ad", "script", ".imgwrap .btn", ".btn-imgbig"],
    cleanTitle: (t) => t.replace(/^\s*\[[^\]]{1,10}\]\s*/, ""),
  },
  {
    host: /^arca\.live$/,
    title: [".article-head .title"],
    content: [".article-body .article-content", ".article-content"],
    remove: [".article-link", "script"],
    // 말머리는 별도 배지 요소라 제목 텍스트를 읽기 전에 지운다
    beforeTitle: (el) => el.querySelectorAll(".badge, .category-badge").forEach((b) => b.remove()),
  },
  {
    host: /(^|\.)ruliweb\.com$/,
    title: [".subject_inner_text", ".subject_text .subject_inner_text", ".subject_text"],
    content: [".view_content", ".board_main_view"],
    remove: ["script", ".row.relative"],
  },
  {
    host: /^brunch\.co\.kr$/,
    title: [".cover_title", "h1.cover_title"],
    content: [".wrap_body"],
    remove: ["script"],
  },
  {
    host: /^n\.news\.naver\.com$|^news\.naver\.com$|^m\.entertain\.naver\.com$|^m\.sports\.naver\.com$/,
    title: ["#title_area", ".media_end_head_headline", "h2.end_tit"],
    content: ["#dic_area", "#newsEndContents", "#articeBody"],
    remove: ["script", ".media_end_summary"],
    // 사진 설명이 다음 문단과 붙지 않도록 별도 문단으로
    prepare: (el) =>
      el.querySelectorAll("em.img_desc").forEach((em) => {
        const p = em.ownerDocument.createElement("p");
        em.replaceWith(p);
        p.appendChild(em);
      }),
  },
  {
    host: /^m\.blog\.naver\.com$/,
    title: [".se-title-text", ".tit_h3", "h3.se_textarea"],
    content: [".se-main-container", "#viewTypeSelector", ".post_ct"],
    remove: ["script", ".se-oglink-info", ".se-module-oglink"],
  },
  {
    host: /(^|\.)tistory\.com$/,
    content: [".tt_article_useless_p_margin", ".entry-content", ".article_view", "#article-view"],
    remove: ["script", ".another_category", ".container_postbtn", ".revenue_unit_wrap", "[data-tistory-react-app]"],
  },
  {
    host: /^news\.hada\.io$/,
    title: [".topictitle h1", ".topictitle"],
    content: ["#topic_contents", ".topic_contents"],
    remove: ["script"],
  },
];

// 가져오기 전에 주소를 본문이 깔끔한 버전으로 바꾼다 (저장되는 url은 원래 주소 그대로).
export function rewriteFetchUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  // 네이버 블로그 PC 화면은 iframe이라 본문이 없다 → 모바일 주소로
  if (u.hostname === "blog.naver.com") {
    const id = u.searchParams.get("blogId");
    const no = u.searchParams.get("logNo");
    if (id && no) return `https://m.blog.naver.com/${id}/${no}`;
    const m = u.pathname.match(/^\/([^/]+)\/(\d+)/);
    if (m) return `https://m.blog.naver.com/${m[1]}/${m[2]}`;
  }
  // 디시인사이드 PC 화면 → 모바일 (광고·스크립트가 적다)
  if (u.hostname === "gall.dcinside.com") {
    const id = u.searchParams.get("id");
    const no = u.searchParams.get("no");
    if (id && no) return `https://m.dcinside.com/board/${id}/${no}`;
  }
  return raw;
}

// 바이트 → 문자열. Content-Type 헤더나 <meta charset>의 인코딩(EUC-KR, Shift_JIS 등)을 따른다.
export function decodeHtml(buffer, contentType = "") {
  const bytes = new Uint8Array(buffer);
  let charset = (contentType.match(/charset=([\w-]+)/i) || [])[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
    charset = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function meta(doc, ...names) {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    const v = el && el.getAttribute("content");
    if (v && v.trim()) return v.trim();
  }
  return "";
}

function firstMatch(root, selectors = []) {
  for (const s of selectors) {
    const el = root.querySelector(s);
    if (el && el.textContent.trim()) return el;
  }
  return null;
}

// 지연 로딩 이미지의 실제 주소를 src로 옮기고, 모든 링크·이미지를 절대 주소로 바꾼다.
function normalizeMedia(root, baseUrl) {
  root.querySelectorAll("img").forEach((img) => {
    const lazy =
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-lazy") ||
      img.getAttribute("data-url");
    const src = img.getAttribute("src") || "";
    if (lazy && (!src || src.startsWith("data:") || /blank|spacer|loading|lazy/i.test(src))) {
      img.setAttribute("src", lazy);
    }
    img.removeAttribute("srcset");
    // 디시 등의 해시값 대체 텍스트는 의미가 없다
    if (/^[0-9a-f_-]{16,}$/i.test(img.getAttribute("alt") || "")) img.setAttribute("alt", "");
  });
  for (const [sel, attr] of [["img", "src"], ["a", "href"], ["video", "src"], ["source", "src"]]) {
    root.querySelectorAll(sel).forEach((el) => {
      const v = el.getAttribute(attr);
      if (!v || v.startsWith("data:") || v.startsWith("#") || v.startsWith("javascript:")) return;
      try {
        el.setAttribute(attr, new URL(v, baseUrl).href);
      } catch {}
    });
  }
  // 갈 곳 없는 링크(<a href="#">, javascript:)는 걷어내고 안의 내용만 남긴다 (네이버 블로그 이미지 래퍼 등)
  root.querySelectorAll("a").forEach((a) => {
    const href = (a.getAttribute("href") || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) a.replaceWith(...a.childNodes);
  });
  // 네이버 블로그 썸네일 주소(w80_blur 등)를 원본 크기로
  root.querySelectorAll("img").forEach((img) => {
    const s = img.getAttribute("src") || "";
    if (/pstatic\.net/.test(s)) img.setAttribute("src", s.replace(/\?type=w\d+_blur$/, "?type=w966"));
  });
}

function cleanTitle(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

/**
 * @param {Document} doc  DOMParser로 만든 문서 (호출 측에서 소유, 이 함수가 수정함)
 * @param {string} url    실제로 가져온 주소
 * @returns {{title:string, html:string, siteName:string, byline:string, fallback:boolean}}
 */
export function extractArticle(doc, url) {
  const host = new URL(url).hostname;
  const siteName = meta(doc, "og:site_name") || host;
  const ogTitle = meta(doc, "og:title", "twitter:title");
  const docTitle = cleanTitle(doc.title);

  const rule = SITE_RULES.find((r) => r.host.test(host));
  if (rule) {
    const titleEl = firstMatch(doc, rule.title);
    if (titleEl && rule.beforeTitle) rule.beforeTitle(titleEl);
    const contentEl = firstMatch(doc, rule.content);
    if (contentEl) {
      (rule.remove || []).forEach((s) => {
        try {
          contentEl.querySelectorAll(s).forEach((e) => e.remove());
        } catch {}
      });
      if (rule.prepare) rule.prepare(contentEl);
      normalizeMedia(contentEl, url);
      let title = cleanTitle(titleEl ? titleEl.textContent : "") || cleanTitle(ogTitle) || docTitle;
      if (rule.cleanTitle) title = cleanTitle(rule.cleanTitle(title));
      return { title, html: contentEl.innerHTML, siteName, byline: "", fallback: false };
    }
  }

  // 일반 사이트: Firefox 읽기 모드와 같은 Readability로 본문 추출
  const metaDesc = meta(doc, "og:description", "description", "twitter:description");
  const ogImage = meta(doc, "og:image", "twitter:image");
  normalizeMedia(doc, url);
  let article = null;
  try {
    article = new Readability(doc, { charThreshold: 200, keepClasses: false }).parse();
  } catch {}

  const textLen = article && article.textContent ? article.textContent.trim().length : 0;
  if (article && textLen >= 100) {
    return {
      title: cleanTitle(article.title) || cleanTitle(ogTitle) || docTitle,
      html: article.content,
      siteName: article.siteName || siteName,
      byline: article.byline || "",
      fallback: false,
    };
  }

  // 본문을 못 찾으면(자바스크립트로 그리는 SPA, SNS 등) 미리보기 정보만이라도 남긴다
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let html = "";
  if (ogImage) html += `<p><img src="${esc(new URL(ogImage, url).href)}"></p>`;
  if (metaDesc) html += `<blockquote><p>${esc(metaDesc)}</p></blockquote>`;
  if (article && textLen > 0) html += article.content;
  return {
    title: cleanTitle(ogTitle) || docTitle || host,
    html,
    siteName,
    byline: "",
    fallback: true,
  };
}

// 본문을 HTML이 아니라 API(JSON)로 받아야 하는 사이트.
// 반환값: { url: 요청할 주소, parse: (응답 문자열) => {title, html} } 또는 null
export function apiOverride(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  // 토스증권 콘텐츠: 화면을 자바스크립트로 그려서 HTML에는 본문이 없다
  const toss = u.hostname === "contents.tossinvest.com" && u.pathname.match(/^\/article\/[^/]+\/(\d+)/);
  if (toss) {
    return {
      url: `https://wts-cert-api.tossinvest.com/api/v3/ipd-thor/api/v1/workspaces/5/posts/${toss[1]}`,
      parse: (text) => {
        const d = JSON.parse(text).success;
        if (!d || !d.fullDescription) return null;
        const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const html = d.fullDescription
          .split(/\n+/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => `<p>${esc(l)}</p>`)
          .join("");
        return { title: d.title, html };
      },
    };
  }
  return null;
}

// 변환된 마크다운 다듬기 (본문 맨 앞의 제목 중복도 지운다)
export function tidyMarkdown(md, title = "") {
  const norm = (s) => s.replace(/[\s*_#]/g, "");
  const lines = md.trimStart().split("\n");
  if (title && /^#{1,6}\s/.test(lines[0] || "") && norm(lines[0]) === norm(title)) lines.shift();
  return (
    lines
      .join("\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b\ufeff]/g, "") // 네이버 블로그가 빈 줄 대신 넣는 보이지 않는 문자
      .replace(/[ \t]+$/gm, "")
      .replace(/^\s*\\?-\s*$/gm, "") // 빈 목록 항목
      .replace(/!\[\]\(\s*\)/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

// 파일 이름으로 쓸 수 없는 문자 제거 (Windows·iOS·Android 공통)
export function safeFileName(title) {
  const name = (title || "제목 없음")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100)
    .trim();
  return name || "제목 없음";
}
