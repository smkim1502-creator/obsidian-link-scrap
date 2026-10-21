// 관련 노트·태그 추천 정확도 측정: node test/eval_related.mjs
// Vault를 읽기만 한다. 직접 달아 둔 관련 노트 링크·태그를 지운 채 추천을 돌려, 원래 것을 얼마나 맞히는지 본다.
import fs from "node:fs";
import path from "node:path";
import { buildIndex, suggest } from "../src/related.js";

const VAULT = "C:/Users/sec/Obsidian Vault/Second Brain";
const EXCLUDE = /^(\.obsidian|\.trash|클로드 코드 프로젝트|해결해야 할 문제)(\/|$)/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(VAULT, p).replace(/\\/g, "/");
    if (EXCLUDE.test(rel)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

function fmList(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-.*\\n?)+)`, "m"));
  if (m) return m[1].split("\n").map((l) => l.replace(/^\s+-\s*/, "").replace(/^["']|["']$/g, "").trim()).filter(Boolean);
  const inline = fm.match(new RegExp(`^${key}:\\s*\\[(.*)\\]`, "m"));
  return inline ? inline[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
}

const notes = walk(VAULT).map((rel) => {
  const text = fs.readFileSync(path.join(VAULT, rel), "utf8").replace(/\r\n/g, "\n");
  const fm = (text.match(/^---\n([\s\S]*?)\n---\n/) || [, ""])[1];
  const gold = new Set();
  const line = text.match(/^관련 노트:.*$/m);
  const sec = text.match(/^## 관련 노트\n[\s\S]*?(?=^## |(?![\s\S]))/m);
  for (const block of [line && line[0], sec && sec[0]]) {
    for (const m of (block || "").matchAll(/\[\[([^\]|#]+)/g)) gold.add(m[1].trim());
  }
  return { path: rel, title: path.basename(rel, ".md"), text, tags: fmList(fm, "tags"), aliases: fmList(fm, "aliases"), gold };
});
const OPTS = { excludeFolders: ["스크랩"], ...JSON.parse(process.argv[2] || "{}") };
const titles = new Set(notes.map((n) => n.title));
const index = buildIndex(notes);
console.log(`노트 ${notes.length}개 색인`);

function evalLinks(label, subset) {
  let hit = 0, found = 0, total = 0;
  const misses = [];
  for (const n of subset) {
    const gold = [...n.gold].filter((g) => titles.has(g));
    if (!gold.length) continue;
    total++;
    const s = suggest(index, { title: n.title, markdown: n.text, excludePath: n.path, folder: path.dirname(n.path).replace(/^.$/, "") }, OPTS);
    const got = s.related.map((r) => r.title);
    const k = gold.filter((g) => got.includes(g)).length;
    if (k) hit++;
    found += k / gold.length;
    if (!k && misses.length < 6) misses.push(`  ${n.title}  정답 ${gold.join(", ")}  추천 ${got.join(", ") || "없음"}`);
  }
  console.log(`\n[${label}] ${total}개 노트: 정답 1개 이상 적중 ${hit}/${total} (${((hit / total) * 100).toFixed(0)}%), 평균 재현율 ${((found / total) * 100).toFixed(0)}%`);
  misses.forEach((m) => console.log(m));
}

function evalTags(label, subset) {
  let exact = 0, anyHit = 0, wrong = 0, total = 0, untagged = 0, untaggedSuggested = 0;
  const samples = [];
  for (const n of subset) {
    if (!n.tags.length) {
      untagged++;
      untaggedSuggested += suggest(index, { title: n.title, markdown: n.text, excludePath: n.path, folder: path.dirname(n.path).replace(/^.$/, "") }, OPTS).tags.length;
      continue;
    }
    total++;
    const s = suggest(index, { title: n.title, markdown: n.text, excludePath: n.path, folder: path.dirname(n.path).replace(/^.$/, "") }, OPTS);
    const ok = s.tags.filter((t) => n.tags.includes(t));
    if (ok.length) anyHit++;
    if (ok.length === n.tags.length && s.tags.length === n.tags.length) exact++;
    wrong += s.tags.length - ok.length;
    if (samples.length < 8) samples.push(`  ${n.title.slice(0, 30)}  실제 ${n.tags.join(",")}  추천 ${s.tags.join(",") || "없음"}`);
  }
  console.log(`\n[${label}] ${total}개 노트: 태그 1개 이상 적중 ${anyHit}/${total} (${((anyHit / total) * 100).toFixed(0)}%), 완전 일치 ${exact}, 틀린 태그 총 ${wrong}개 / 태그 없는 노트 ${untagged}개에 추천된 태그 ${untaggedSuggested}개`);
  samples.forEach((m) => console.log(m));
}

const isNintendo = (n) => n.path.includes("닌텐도 채용 키워드");
evalLinks("관련 노트 — 스크랩(닌텐도 시리즈 제외)", notes.filter((n) => n.path.startsWith("스크랩/") && !isNintendo(n)));
evalLinks("관련 노트 — 닌텐도 키워드 시리즈", notes.filter(isNintendo));
evalTags("태그 — 스크랩(닌텐도 시리즈 제외)", notes.filter((n) => n.path.startsWith("스크랩/") && !isNintendo(n)));
