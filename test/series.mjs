// 여러 편으로 나뉜 글 합치기: node test/series.mjs
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { findParts, extractArticle } from "../src/extract.js";
import { scrapSeries } from "../src/scrap.js";

const doc = (html, url) => new JSDOM(html, { url }).window.document;
const TOC = `<ul class="interview-index-list">
<li><a href="./index.html"><div class="interview-index-btn__label">｢젤다｣의 터닝 포인트</div></a></li>
<li><a href="./02.html"><div class="interview-index-btn__label">겉모습은 변해도</div></a></li>
<li><a href="./03.html"><div class="interview-index-btn__label">지금의 시대에</div></a></li>
<li><a href="./04.html"><div class="interview-index-btn__label">모든 것이 풍성해지다</div></a></li>
</ul><a href="./04.html">다음</a><a href="../index.html">목록</a><a href="../totk/index.html">다른 인터뷰</a>`;

// 1) 편 목록: 같은 폴더의 index·숫자 페이지, 목차 제목, 순서. 어느 편에서 시작해도 같다
{
  const want = [
    ["https://www.nintendo.com/kr/interview/aa9ja/index.html", "｢젤다｣의 터닝 포인트"],
    ["https://www.nintendo.com/kr/interview/aa9ja/02.html", "겉모습은 변해도"],
    ["https://www.nintendo.com/kr/interview/aa9ja/03.html", "지금의 시대에"],
    ["https://www.nintendo.com/kr/interview/aa9ja/04.html", "모든 것이 풍성해지다"],
  ];
  for (const u of ["https://www.nintendo.com/kr/interview/aa9ja/", "https://www.nintendo.com/kr/interview/aa9ja/03.html"]) {
    assert.deepEqual(findParts(doc(TOC, u), u).map((p) => [p.url, p.label]), want);
  }
  // 나뉜 글이 아니면 빈 목록: 숫자 이름이 아닌 페이지, 편 링크가 하나뿐인 페이지
  assert.deepEqual(findParts(doc(TOC, "https://www.nintendo.com/kr/interview/aa9ja/story.html"), "https://www.nintendo.com/kr/interview/aa9ja/story.html"), []);
  assert.deepEqual(findParts(doc('<a href="./index.html">처음</a>', "https://x.com/a/index.html"), "https://x.com/a/index.html"), []);
  assert.deepEqual(findParts(doc('<a href="/other/02.html">x</a>', "https://x.com/a/index.html"), "https://x.com/a/index.html"), []);
}
console.log("1 편 목록 OK");

// 2) 닌텐도 인터뷰 본문: 말하는 사람 이름을 굵게, 묻는 쪽은 —, 목차는 뺀다, 제목의 ｜닌텐도는 뗀다
{
  const html = `<title>개발자에게 물어보았습니다 : 젤다의 전설 시간의 오카리나｜닌텐도</title>
<div class="interview-main-sec__body">${TOC}
<div class="interview-balloon-left"><p class="interview-balloon-left__text">자기소개를 부탁드립니다.</p></div>
<div class="interview-balloon-right"><div class="interview-balloon-right__header"><div class="interview-balloon-right__header-name">고</div></div>
<div class="interview-balloon-right__body"><p class="interview-balloon-right__text">디렉터인 고입니다.</p></div></div></div>`;
  const a = extractArticle(doc(html, "https://www.nintendo.com/kr/interview/aa9ja/02.html"), "https://www.nintendo.com/kr/interview/aa9ja/02.html");
  assert.equal(a.title, "개발자에게 물어보았습니다 : 젤다의 전설 시간의 오카리나");
  assert.match(a.html, /<strong>— <\/strong>\s*자기소개/);
  assert.match(a.html, /<strong>고: <\/strong>\s*디렉터인 고입니다/);
  assert.ok(!a.html.includes("터닝 포인트") && !a.html.includes("header-name"));
}
console.log("2 닌텐도 인터뷰 본문 OK");

// 3) 합치기: 1편 주소로, 편마다 "## N. 제목", 못 받은 편은 표시
{
  const parts = [
    { url: "https://x.com/a/index.html", label: "첫 편" },
    { url: "https://x.com/a/02.html", label: "" },
    { url: "https://x.com/a/03.html", label: "셋째 편" },
  ];
  const first = { kind: "article", url: "https://x.com/a/02.html", title: "대담", markdown: "둘째 본문\n", parts };
  // scrapUrl이 네트워크로 받는 편은 가짜 io로
  const io = {
    request: async (u) => {
      if (u.endsWith("03.html")) throw new Error("x");
      return { status: 200, contentType: "text/html", body: new TextEncoder().encode(`<title>대담</title><article><p>${"첫 본문 ".repeat(40)}</p></article>`).buffer };
    },
    parseHtml: (h, u) => doc(h, u),
    toMarkdown: (h) => h.replace(/<[^>]+>/g, "").trim(),
  };
  const s = await scrapSeries(first, io);
  assert.equal(s.url, "https://x.com/a/index.html");
  assert.match(s.markdown, /^## 1\. 첫 편\n\n첫 본문/);
  assert.match(s.markdown, /## 2\. 2편\n\n둘째 본문/);
  assert.match(s.markdown, /## 3\. 셋째 편\n\n\(이 편을 가져오지 못했습니다: https:\/\/x\.com\/a\/03\.html\)/);
  assert.equal(s.missing, 1);
}
console.log("3 합치기 OK");
console.log("모두 통과");
