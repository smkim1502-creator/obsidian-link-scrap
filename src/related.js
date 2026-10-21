// 새 글과 Vault의 기존 노트를 비교해 관련 노트·태그를 고른다. 외부 API 없이 기기 안에서 계산.
// - 내용 유사도: 한·중·일 문자는 2글자 단위, 영문·숫자는 단어 단위로 쪼갠 TF-IDF 코사인 유사도
// - 제목 언급: 기존 노트 제목(또는 별칭)이 새 글에 그대로 나오면 가산점. 흔한 제목·더 긴 제목에 포함된 제목은 제외
// - 태그: 저장할 폴더에서 주로 쓰는 태그 + 본문에 이름이 여러 번 나오는 태그 + 아주 비슷한 노트의 태그

const CJK = /[぀-ヿ㐀-鿿가-힯]+/g;
const WORD = /[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]/g;
const STOP = new Set("the and for with that this from are was were you your have has not but can will http https www com html amp nbsp".split(" "));

export const DEFAULT_OPTS = {
  maxRelated: 3,
  minScore: 0.12, // 이보다 덜 비슷하면 관련 노트로 보지 않는다
  mentionBonus: 0.2,
  genericRatio: 0.15, // 노트의 15% 넘게 등장하는 제목(예: "프로젝트")은 언급으로 치지 않는다
  maxTags: 3,
  folderTagShare: 0.5, // 같은 폴더 노트의 절반 이상이 단 태그
  tagMentionMin: 3, // 태그 이름이 본문에 이만큼 나오면
  neighborTagScore: 0.35, // 이만큼 비슷한 노트의 태그는 빌려온다
  shortLen: 0, // 토큰이 이보다 적은 짧은 노트는 유사도를 깎는다 (짧을수록 우연히 겹치기 쉬움)
  excludeFolders: [], // 관련 노트 후보에서 뺄 폴더 (스크랩끼리는 링크하지 않는다)
};

// 마크다운에서 비교에 쓸 글만 남긴다
export function plainText(md) {
  return md
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/^관련 노트:.*$/gm, "")
    .replace(/^## 관련 노트[\s\S]*?(?=^## |(?![\s\S]))/gm, "")
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/https?:\/\/\S+/g, " ");
}

export function tokenize(text) {
  const t = text.toLowerCase();
  const out = [];
  for (const run of t.match(CJK) || []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  for (const w of t.replace(CJK, " ").match(WORD) || []) if (w.length > 1 && !STOP.has(w)) out.push(w);
  return out;
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

const normName = (s) => s.toLowerCase().replace(/[\s_·・:：\-–—'"「」『』()（）[\]]/g, "");
const folderOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const validTag = (t) => /^[^\s#,]+$/.test(t);

function countOf(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * @param {{path:string, title:string, aliases?:string[], tags?:string[], text:string}[]} notes
 */
export function buildIndex(notes) {
  const df = new Map();
  const docs = notes.map((n) => {
    // 제목은 본문보다 3배 무겁게
    const tt = tokenize(n.title);
    const bodyTokens = tokenize(plainText(n.text));
    const tf = termFreq([...tt, ...tt, ...tt, ...bodyTokens]);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { path: n.path, title: n.title, folder: folderOf(n.path), tags: (n.tags || []).filter(validTag), aliases: n.aliases || [], len: bodyTokens.length, tf };
  });
  const N = docs.length;
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  for (const d of docs) {
    d.vec = new Map();
    let norm = 0;
    for (const [t, c] of d.tf) {
      const w = (1 + Math.log(c)) * idf(t);
      d.vec.set(t, w);
      norm += w * w;
    }
    d.norm = Math.sqrt(norm) || 1;
    delete d.tf;
  }

  // 제목이 얼마나 흔한 말인지: 제목의 모든 토큰을 가진 노트 수로 어림한다
  for (const d of docs) {
    d.names = [d.title, ...d.aliases]
      .map((raw) => ({ raw, norm: normName(raw) }))
      .filter((x) => x.norm.length >= 2)
      .map((x) => {
        const toks = [...new Set(tokenize(x.raw))];
        const containing = toks.length ? docs.filter((o) => toks.every((t) => o.vec.has(t))).length : N;
        return { norm: x.norm, generic: containing / N };
      });
  }

  // 폴더별 태그 사용 비율
  const folders = new Map();
  for (const d of docs) {
    const f = folders.get(d.folder) || { n: 0, tags: new Map() };
    f.n++;
    for (const t of d.tags) f.tags.set(t, (f.tags.get(t) || 0) + 1);
    folders.set(d.folder, f);
  }
  const allTags = [...new Set(docs.flatMap((d) => d.tags))];
  return { docs, idf, folders, allTags };
}

/**
 * @param {{title:string, markdown:string, folder?:string, excludePath?:string}} input
 * @returns {{related:{path:string,title:string,score:number,mentioned:boolean}[], tags:string[]}}
 */
export function suggest(index, { title, markdown, folder = "", excludePath }, options = {}) {
  const o = { ...DEFAULT_OPTS, ...options };
  const body = plainText(markdown);
  const tt = tokenize(title);
  const tf = termFreq([...tt, ...tt, ...tt, ...tokenize(body)]);
  const q = new Map();
  let qn = 0;
  for (const [t, c] of tf) {
    const w = (1 + Math.log(c)) * index.idf(t);
    q.set(t, w);
    qn += w * w;
  }
  qn = Math.sqrt(qn) || 1;
  const flat = normName(title + " " + body);

  const scored = [];
  for (const d of index.docs) {
    if (d.path === excludePath) continue;
    let dot = 0;
    const [small, big] = q.size < d.vec.size ? [q, d.vec] : [d.vec, q];
    for (const [t, w] of small) {
      const v = big.get(t);
      if (v) dot += w * v;
    }
    let sim = dot / (qn * d.norm);
    if (o.shortLen && d.len < o.shortLen) sim *= Math.sqrt(d.len / o.shortLen);
    const hit = d.names.find((n) => n.generic <= o.genericRatio && n.norm.length >= 3 && flat.includes(n.norm));
    scored.push({ d, sim, mention: hit ? hit.norm : null });
  }

  // 언급된 제목이 다른 언급된 제목에 포함되면(스플래툰 ⊂ 스플래툰 2) 짧은 쪽은 언급으로 치지 않는다
  const mentions = scored.filter((s) => s.mention).map((s) => s.mention);
  for (const s of scored) {
    if (s.mention && mentions.some((m) => m !== s.mention && m.includes(s.mention))) s.mention = null;
    s.score = s.sim + (s.mention ? o.mentionBonus : 0);
  }
  scored.sort((a, b) => b.score - a.score);

  const excluded = (p) => o.excludeFolders.some((f) => f && (p === f || p.startsWith(f + "/")));
  const related = scored
    .filter((s) => s.score >= o.minScore && !excluded(s.d.path))
    .slice(0, o.maxRelated)
    .map((s) => ({ path: s.d.path, title: s.d.title, score: +s.score.toFixed(3), mentioned: !!s.mention }));

  // 태그
  const tags = [];
  const add = (t) => !tags.includes(t) && tags.length < o.maxTags && tags.push(t);
  const f = index.folders.get(folder);
  if (f) {
    const self = index.docs.find((d) => d.path === excludePath);
    const n = f.n - (self && self.folder === folder ? 1 : 0);
    [...f.tags.entries()]
      .map(([t, c]) => [t, c - (self && self.folder === folder && self.tags.includes(t) ? 1 : 0)])
      .filter(([, c]) => c >= 2 && c / n >= o.folderTagShare)
      .sort((a, b) => b[1] - a[1])
      .forEach(([t]) => add(t));
  }
  for (const t of index.allTags) {
    const leaf = normName(t.split("/").pop());
    if (leaf.length >= 2 && countOf(flat, leaf) >= o.tagMentionMin + (leaf.length <= 2 ? 2 : 0)) add(t);
  }
  for (const s of scored) {
    if (s.sim < o.neighborTagScore) break;
    s.d.tags.forEach(add);
  }
  return { related, tags };
}
