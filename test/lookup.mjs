// 한국 정식 명칭 찾기: node test/lookup.mjs  (--real: 실제 위키백과로)
import assert from "node:assert/strict";
import { wikiKorean, parseSearch, addAuto, findKorean, AUTO_HEAD } from "../src/lookup.js";
import { parseTerms } from "../src/transform.js";

// 1) 위키백과 응답: 넘겨주기를 따라가고, 구분 괄호를 떼고, 한국어 문서가 없으면 뺀다
const wiki = {
  query: {
    normalized: [{ from: "ファミコン", to: "ファミコン" }],
    redirects: [{ from: "ファミコン", to: "ファミリーコンピュータ" }],
    pages: [
      { title: "カービィ", langlinks: [{ lang: "ko", title: "커비 (캐릭터)" }] },
      { title: "ファミリーコンピュータ", langlinks: [{ lang: "ko", title: "패밀리컴퓨터" }] },
      { title: "スプラトゥーン3" },
      { title: "ない", missing: true },
    ],
  },
};
assert.deepEqual([...wikiKorean(wiki, ["カービィ", "ファミコン", "スプラトゥーン3", "ない"])], [["カービィ", "커비"], ["ファミコン", "패밀리컴퓨터"]]);
console.log("1 위키백과 OK");

// 2) 웹 검색 결과: 근거 주소가 있는 줄만, 표 모양도 받는다. 없음·추측은 버린다
const out = `| 원어 → 한국 정식 명칭 | 근거 URL |
|---|---|
| カービィのエアライダー → 없음 | 확인하지 못함 |
| スプラトゥーン3 → 스플래툰 3 | https://www.nintendo.com/kr/interview/av5ja/03.php |
- ハイラル → 하이랄 | https://www.gamemeca.com/view.php?gid=978230
ドンキーコング バナンザ → 동키콩 바난자
モブ → 모브 | https://x.example/`;
const s = parseSearch(out, ["カービィのエアライダー", "スプラトゥーン3", "ハイラル", "ドンキーコング バナンザ"]);
assert.deepEqual([...s].map(([k, v]) => `${k}=${v.to}`), ["スプラトゥーン3=스플래툰 3", "ハイラル=하이랄"]);
console.log("2 웹 검색 읽기 OK");

// 3) 용어집에 더하기: 자동 칸을 만들고, 있는 원어는 건너뛰고, 출처 주석은 표기에 섞이지 않는다
let note = "# 번역 용어집\n\n- カービィ → 커비\n";
note = addAuto(note, [{ from: "カービィ", to: "커비", source: "위키백과" }, { from: "スプラトゥーン3", to: "스플래툰 3", source: "웹 검색 https://a" }]);
assert.ok(note.includes(AUTO_HEAD) && note.includes("- スプラトゥーン3 → 스플래툰 3 %% 웹 검색 https://a %%"));
assert.equal(note.match(/カービィ/g).length, 1);
note = addAuto(note, [{ from: "ハイラル", to: "하이랄", source: "위키백과" }]);
assert.equal(note.match(new RegExp(AUTO_HEAD, "g")).length, 1);
assert.deepEqual(parseTerms(note).map((t) => t.join("=")).sort(), ["カービィ=커비", "スプラトゥーン3=스플래툰 3", "ハイラル=하이랄"]);
console.log("3 용어집에 더하기 OK");

// 4) 위키백과 후보는 Claude가 맥락을 확인한 것만(표기를 바꿔 오면 버림), 나머지는 웹 검색. 확인을 못 하면 아무것도 더하지 않는다
{
  const asked = [];
  const wiki2 = { query: { pages: [...wiki.query.pages, { title: "パドック", langlinks: [{ lang: "ko", title: "예시장" }] }, { title: "ファミコン", langlinks: [{ lang: "ko", title: "패밀리컴퓨터" }] }] } };
  const found = await findKorean(["カービィ", "パドック", "ファミコン", "スプラトゥーン3", "ない"], {
    title: "『カービィのエアライダー』最適化",
    getJson: async () => wiki2,
    search: async (p) => (
      asked.push(p),
      "カービィ → 커비 | 위키백과\nパドック → 없음\nファミコン → 패미컴 | 위키백과\nスプラトゥーン3 → 스플래툰 3 | https://www.nintendo.com/kr/x\nない → 없음"
    ),
  });
  assert.deepEqual(found.map((f) => `${f.from}=${f.to}:${f.source.split(" ")[0]}`), ["カービィ=커비:위키백과", "スプラトゥーン3=스플래툰 3:웹"]);
  const p = asked[0];
  assert.ok(p.includes("글 제목: 『カービィのエアライダー』最適化") && p.includes("パドック → 예시장") && /B\. [\s\S]*スプラトゥーン3\nない/.test(p), p);
  assert.ok(!/B\. [\s\S]*カービィ\n/.test(p));
  assert.deepEqual(await findKorean(["カービィ"], { getJson: async () => wiki }), []);
  const none = await findKorean(["x"], { getJson: async () => { throw new Error("net"); }, search: async () => { throw new Error("no"); } });
  assert.deepEqual(none, []);
}
console.log("4 맥락 확인·찾는 순서 OK");

// 5) 이름 뽑기 결과·위키백과 언어 고르기
{
  const { parseNames, wikiLang } = await import("../src/lookup.js");
  assert.deepEqual(parseNames("1. Bombchu\n- Gold Skulltula\nカービィ → 커비\nBombchu\n없음"), ["Bombchu", "Gold Skulltula", "カービィ"]);
  assert.equal(wikiLang("パドック"), "ja");
  assert.equal(wikiLang("Gold Skulltula"), "en");
}
console.log("5 이름 뽑기 OK");

// 6) 공식 누리집 비교: 원어판에서 이름이 나오는 부분을 보여 주고, 한국판에 실제로 있는 표기만 받는다
{
  const { parseSites, snippets, comparePrompt, parseCompare, htmlText } = await import("../src/lookup.js");
  assert.deepEqual(parseSites("x → y | 위키백과\n공식 누리집: https://www.nintendo.com/jp/a/ | https://www.nintendo.com/kr/a/"), [{ src: "https://www.nintendo.com/jp/a/", ko: "https://www.nintendo.com/kr/a/" }]);
  const ja = htmlText('<script>var パドック=1</script><p>レース前は<b>パドック</b>に集まります。</p><img alt="パドックの画面">&amp;');
  assert.ok(!ja.includes("var") && ja.includes("パドック") && ja.includes("パドックの画面") && ja.endsWith("&"));
  assert.equal(snippets(ja, "パドック").length, 2);
  const ko = "레이스 전에는 대기소에 모입니다.";
  const p = comparePrompt([["パドック", snippets(ja, "パドック")]], ko);
  assert.ok(p.includes("[パドック]") && p.includes("<한국판>\n레이스 전에는"));
  const got = parseCompare("パドック → 대기소 | 레이스 전에는 대기소에\nシティトライアル → 시티 트라이얼 | 없는 문장\nほか → 예시장", ["パドック", "シティトライアル", "ほか"], ko);
  assert.deepEqual([...got], [["パドック", "대기소"]]);

  // 흐름: 검색이 못 찾은 이름을 누리집 비교로 찾는다
  const found = await findKorean(["パドック"], {
    title: "エアライダー",
    getJson: async () => ({ query: { pages: [{ title: "パドック", langlinks: [{ lang: "ko", title: "예시장" }] }] } }),
    search: async () => "パドック → 없음\n공식 누리집: https://jp.example/ | https://kr.example/",
    getText: async (url) => (url.includes("kr") ? ko : ja),
    compare: async () => "パドック → 대기소 | 레이스 전에는 대기소에",
  });
  assert.deepEqual([...found], [{ from: "パドック", to: "대기소", source: "공식 누리집 비교 https://kr.example/" }]);
  assert.deepEqual(found.missed, []);
}
console.log("6 공식 누리집 비교 OK");

// 7) 노트 표기 맞추기: 노트에 실제로 있고, 바꿀 표기가 용어집의 정식 표기인 것만
{
  const { fixPrompt, parseFixPairs } = await import("../src/lookup.js");
  const terms = [["Bombchu", "봄추"], ["Gold Skulltula", "황금 스타르츄라"]];
  const body = "# 봄츄 볼링\n\n황금 스컬트라와 봄츄.";
  assert.ok(fixPrompt(body, terms).includes("Bombchu → 봄추"));
  assert.deepEqual(parseFixPairs("봄츄 → 봄추\n- 황금 스컬트라 → 황금 스타르츄라\n없는말 → 봄추\n볼링 → 공굴리기\n봄추 → 봄추", body, terms), [["황금 스컬트라", "황금 스타르츄라"], ["봄츄", "봄추"]]);
}
console.log("7 노트 표기 맞추기 OK");

if (process.argv.includes("--real")) {
  const { wikiUrl } = await import("../src/lookup.js");
  const names = ["カービィ", "バンダイナムコスタジオ", "宮本茂", "パドック"];
  const j = await (await fetch(wikiUrl(names), { headers: { "User-Agent": "link-scrap (Obsidian plugin)" } })).json();
  const w = wikiKorean(j, names);
  console.log("실제 위키백과:", [...w].map((x) => x.join(" → ")).join(", "));
  assert.equal(w.get("カービィ"), "커비");
}
console.log("모두 통과");
