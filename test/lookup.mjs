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

if (process.argv.includes("--real")) {
  const { wikiUrl } = await import("../src/lookup.js");
  const names = ["カービィ", "バンダイナムコスタジオ", "宮本茂", "パドック"];
  const j = await (await fetch(wikiUrl(names), { headers: { "User-Agent": "link-scrap (Obsidian plugin)" } })).json();
  const w = wikiKorean(j, names);
  console.log("실제 위키백과:", [...w].map((x) => x.join(" → ")).join(", "));
  assert.equal(w.get("カービィ"), "커비");
}
console.log("모두 통과");
