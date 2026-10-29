// 옵시디언 플러그인 본체: 입력창·저장·설정·obsidian://scrap 주소 처리
import {
  Plugin,
  Modal,
  Notice,
  Setting,
  PluginSettingTab,
  TFolder,
  normalizePath,
  requestUrl,
  htmlToMarkdown,
  Platform,
  TFile,
  parseFrontMatterTags,
  parseFrontMatterAliases,
} from "obsidian";
import { scrapUrl, findUrl, cleanUrl, BLOCKED_TITLE } from "./scrap.js";
import { safeFileName, USER_AGENT } from "./extract.js";
import { buildIndex, suggest, suggestFolder } from "./related.js";
import { transformArticle, finishDraft, claudeTitle, googleTitle, isKorean, ClaudeRefused } from "./transform.js";
import { claudeRunner, findClaude } from "./claude.js";
import { KEY, draftHash, hasJobs, markerLine, parseNote, buildNote } from "./pending.js";

// 입력창·명령에서 "내용을 보고 폴더 고르기"를 뜻하는 값
const AUTO_FOLDER = "__auto__";

const DEFAULT_SETTINGS = {
  rootFolder: "스크랩",
  lastFolder: "스크랩",
  saveImages: false,
  imageFolder: "_resources/스크랩",
  openAfter: true,
  autoFolder: true,
  autoTags: true,
  // 관련 노트 링크는 기본으로 달지 않는다 (사용자가 옵시디언을 정리할 때 한꺼번에 한다)
  autoLinks: false,
  maxRelated: 3,
  // 비교 대상에서 아예 뺄 폴더 (작업 기록 등)
  excludeFolders: "클로드 코드 프로젝트, 해결해야 할 문제",
  // Claude로 마무리: PC는 설치된 Claude Code(구독 계정)로 구글 번역을 확인하고 요약을 쓴다.
  // 모바일은 초안에 "Claude 확인 대기" 표시를 달아, PC 옵시디언이 동기화로 받으면 마무리하게 한다
  claude: true,
  claudeModel: "sonnet",
  claudePath: "",
  // 외국어 제목 노트에 한국어 제목을 별칭으로 단다
  koreanAlias: true,
  // 저장된 설정의 판. 2: 관련 노트 링크를 한 번 끄고, 번역·요약 기본값을 없앴다 (1.3.1)
  settingsVersion: 2,
};

// 저장 형태 네 가지. 스크랩할 때마다 이 중에서 고른다 (기본값 없음)
const MODES = [
  ["원문 · 전문", { translate: false, summary: false }],
  ["원문 · 요약", { translate: false, summary: true }],
  ["번역 · 전문", { translate: true, summary: false }],
  ["번역 · 요약", { translate: true, summary: true }],
];

const splitList = (s) => (s || "").split(",").map((x) => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
const inFolders = (path, folders) => folders.some((f) => path === f || path.startsWith(f + "/"));

const io = {
  request: async (url, userAgent) => {
    const res = await requestUrl({
      url,
      method: "GET",
      headers: { "User-Agent": userAgent, "Accept-Language": "ko-KR,ko;q=0.9,ja;q=0.8,en;q=0.7" },
      throw: false,
    });
    const type = Object.entries(res.headers || {}).find(([k]) => k.toLowerCase() === "content-type");
    return { status: res.status, contentType: type ? type[1] : "", body: res.arrayBuffer };
  },
  // 구글 번역용
  post: async (url, body, contentType) => {
    const res = await requestUrl({ url, method: "POST", contentType, body, throw: false });
    return { status: res.status, text: res.text };
  },
  parseHtml: (html, url) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    // 상대 주소 해석 기준을 원래 페이지로
    const base = doc.createElement("base");
    base.href = url;
    doc.head.prepend(base);
    return doc;
  },
  toMarkdown: (html) => htmlToMarkdown(html),
  // PC 전용: 화면 밖 webview(옵시디언 웹 뷰어와 같은 엔진)로 열어 자바스크립트 검사를 통과시킨 뒤 HTML을 읽는다
  renderPage: Platform.isDesktopApp ? renderInWebview : undefined,
};

function renderInWebview(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const wv = document.createElement("webview");
    wv.setAttribute("src", url);
    wv.setAttribute("partition", "persist:link-scrap");
    wv.setAttribute("useragent", USER_AGENT);
    wv.style.cssText = "position:fixed;left:-20000px;top:0;width:1200px;height:900px;";
    let poll = null;
    const finish = (fn, v) => {
      clearTimeout(timer);
      clearInterval(poll);
      wv.remove();
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, new Error("시간 초과")), timeoutMs);
    wv.addEventListener("dom-ready", () => {
      if (poll) return;
      poll = setInterval(async () => {
        try {
          const [title, html] = await wv.executeJavaScript("[document.title, document.documentElement.outerHTML]");
          if (!BLOCKED_TITLE.test(title) && html.length > 2000) finish(resolve, html);
        } catch {}
      }, 1000);
    });
    document.body.appendChild(wv);
  });
}

// YAML에서 특별한 뜻이 있는 경우에만 따옴표로 감싼다 (기존 노트처럼 url·한글 태그는 그대로)
function yamlValue(v) {
  const risky = /^[-?:,[\]{}#&*!|>'"%@`\s]|[\s:]$|: | #/.test(v) || /^(true|false|null|yes|no|~|[\d.]+)$/i.test(v);
  return risky ? JSON.stringify(v) : v;
}

function sniffImageExt(bytes, contentType, url) {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b[0] === 0x47 && b[1] === 0x49) return "gif";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  const t = (contentType.match(/image\/(\w+)/) || [])[1];
  if (t) return t === "jpeg" ? "jpg" : t === "svg" ? "svg" : t;
  return (url.match(/\.(jpe?g|png|gif|webp|avif|svg)(\?|$)/i) || [, "jpg"])[1].toLowerCase();
}

export default class LinkScrapPlugin extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // 1.3.1: 관련 노트 링크는 기본으로 끄고(전에 저장된 '켬'도 한 번 끈다), 번역·요약 기본값은 없앤다
    if (saved && !(saved.settingsVersion >= 2)) {
      this.settings.autoLinks = false;
      for (const k of ["defaultTranslate", "defaultSummary", "engine"]) delete this.settings[k];
      this.settings.settingsVersion = 2;
      await this.saveData(this.settings);
    }

    this.addRibbonIcon("newspaper", "링크 스크랩", () => this.openModal());
    this.addCommand({ id: "scrap-link", name: "링크 스크랩", callback: () => this.openModal() });
    this.addCommand({
      id: "scrap-clipboard",
      name: "클립보드 링크 빠른 스크랩",
      callback: async () => {
        const url = findUrl(await this.readClipboard());
        if (!url) return new Notice("클립보드에 링크가 없습니다");
        this.chooseMode(url, this.defaultFolder(), []);
      },
    });

    // obsidian://scrap?url=...&folder=...&tags=a,b  (모바일 공유 단축어용). 저장 형태를 고르는 창을 띄운다
    // &translate=1&summary=1 처럼 형태를 주소에 적으면 묻지 않고 그대로 저장한다
    this.registerObsidianProtocolHandler("scrap", (params) => {
      const url = findUrl(params.url || params.text || "");
      if (!url) return this.openModal();
      const tags = (params.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
      if (params.ask === "1" || params.ask === "true") return this.openModal(url);
      const folder = params.folder || this.defaultFolder();
      if (params.translate === undefined && params.summary === undefined) return this.chooseMode(url, folder, tags);
      const on = (v) => v === "1" || v === "true";
      this.scrap(url, folder, tags, { translate: on(params.translate), summary: on(params.summary) });
    });

    this.addSettingTab(new LinkScrapSettingTab(this.app, this));

    // 관련 노트 색인은 처음 쓸 때 만들고, 노트가 바뀌면 다음 스크랩 때 다시 만든다
    this.index = null;
    const invalidate = (f) => f instanceof TFile && f.extension === "md" && (this.index = null);
    for (const ev of ["create", "modify", "delete", "rename"]) this.registerEvent(this.app.vault.on(ev, invalidate));

    // PC: "Claude 확인 대기" 노트(휴대폰 초안, Claude가 실행되지 않았던 PC 초안)를 마무리한다.
    // 동기화로 노트가 들어오거나 바뀌면 잠시 기다렸다가, 옵시디언을 켰을 때는 동기화가 끝날 즈음 한 번 훑는다
    this.pending = new Set();
    this.triedPending = new Set(); // 이번 실행에서 이미 시도한 노트 (같은 노트로 알림이 반복되지 않게)
    this.claudeDown = false;
    this.registerEvent(this.app.metadataCache.on("changed", (f) => this.queuePending(f)));
    this.app.workspace.onLayoutReady(() => (this.startTimer = setTimeout(() => this.scanPending(), 20000)));
    const desktopCommand = (id, name, run) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          if (!Platform.isDesktopApp) return false;
          if (!checking) run();
          return true;
        },
      });
    desktopCommand("finish-pending", "Claude 확인 대기 노트 모두 마무리", () => {
      this.claudeDown = false;
      this.triedPending.clear();
      if (!this.scanPending(0)) new Notice("Claude 확인 대기 노트가 없습니다");
    });
    desktopCommand("finish-this", "이 노트 Claude로 마무리", () => this.finishActive());
  }

  onunload() {
    clearTimeout(this.startTimer);
    clearTimeout(this.pendingTimer);
  }

  async getIndex() {
    if (this.index) return this.index;
    const excluded = splitList(this.settings.excludeFolders);
    const files = this.app.vault.getMarkdownFiles().filter((f) => !inFolders(f.path, excluded));
    const notes = await Promise.all(
      files.map(async (f) => {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        return {
          path: f.path,
          title: f.basename,
          text: await this.app.vault.cachedRead(f),
          url: typeof fm?.url === "string" ? fm.url : "",
          tags: (parseFrontMatterTags(fm) || []).map((t) => t.replace(/^#/, "")),
          aliases: parseFrontMatterAliases(fm) || [],
        };
      })
    );
    this.index = buildIndex(notes);
    return this.index;
  }

  defaultFolder() {
    return this.settings.autoFolder ? AUTO_FOLDER : this.settings.lastFolder;
  }

  // 앱을 막 켠 참이면(공유 단축어로 옵시디언이 열릴 때) 화면이 준비된 뒤에 창을 띄운다
  whenReady(fn) {
    if (this.app.workspace.layoutReady) fn();
    else this.app.workspace.onLayoutReady(fn);
  }

  // 저장 형태(원문/번역 × 전문/요약)만 고르는 작은 창
  chooseMode(url, folder, tags) {
    this.whenReady(() => new ModeModal(this.app, this, url, folder, tags).open());
  }

  // PC에서 Claude Code로 마무리할 때만 실행기를 만든다 (모바일에는 Node가 없어 초안만 만든다)
  claude() {
    const s = this.settings;
    if (!Platform.isDesktopApp || !s.claude) return undefined;
    try {
      return claudeRunner(require, { cliPath: s.claudePath, model: s.claudeModel });
    } catch (e) {
      console.error("[link-scrap] Claude Code 실행 준비 실패", e);
      return undefined;
    }
  }

  // 외국어 제목이면 한국어로 옮긴 제목을 별칭으로 (기존 일본어 스크랩 노트들과 같은 방식). 실패하면 별칭 없이 저장
  // pending: 구글 번역으로 옮겨서 나중에 Claude가 다시 옮기면 좋음
  async koreanAliases(title, runClaude) {
    if (!this.settings.koreanAlias || isKorean(title)) return { aliases: [], pending: false };
    let t = "";
    let pending = true;
    if (runClaude) {
      try {
        t = await claudeTitle(title, runClaude);
        pending = false;
      } catch (e) {
        pending = !(e instanceof ClaudeRefused);
      }
    }
    try {
      if (!t) t = await googleTitle(title, io.post);
    } catch (e) {
      console.error("[link-scrap] 제목 번역 실패", e);
    }
    return t && t !== title ? { aliases: [t], pending } : { aliases: [], pending: false };
  }

  // ---------- Claude 확인 대기 노트 (PC) ----------

  // 노트에 표시가 있으면 줄에 넣고, 잠시 뒤(동기화가 끝날 즈음) 차례로 마무리한다
  queuePending(file, delay = 15000) {
    if (!Platform.isDesktopApp || !this.settings.claude) return false;
    if (!(file instanceof TFile) || file.extension !== "md" || this.triedPending.has(file.path)) return false;
    const v = this.app.metadataCache.getFileCache(file)?.frontmatter?.[KEY];
    if (typeof v !== "string" || !v.includes("확인 대기")) return false;
    this.pending.add(file.path);
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.runPending(), delay);
    return true;
  }

  scanPending(delay = 1000) {
    let n = 0;
    for (const f of this.app.vault.getMarkdownFiles()) if (this.queuePending(f, delay)) n++;
    return n;
  }

  async runPending() {
    if (this.pendingBusy || !this.claude()) return;
    this.pendingBusy = true;
    let done = 0;
    try {
      while (this.pending.size && !this.claudeDown) {
        const path = this.pending.values().next().value;
        this.pending.delete(path);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) continue;
        this.triedPending.add(path);
        const name = file.basename;
        const notice = new Notice(`Claude가 「${name}」을 마무리하는 중…`, 0);
        try {
          const res = await this.finishNote(file, { say: (m) => notice.setMessage(`「${name}」: ${m}`) });
          if (res === "done") done++;
          if (res === "edited") new Notice(`「${name}」은 노트를 고친 흔적이 있어 Claude 확인을 건너뛰었습니다. 노트를 열고 명령 '이 노트 Claude로 마무리'를 실행하면 고친 내용 대신 Claude가 마무리한 내용으로 바뀝니다.`, 15000);
        } catch (e) {
          if (e.claudeDown) {
            // Claude Code가 실행되지 않으면 남은 노트도 안 되므로 멈추고, 다음에 옵시디언을 켜거나 명령을 실행할 때 다시 한다
            this.claudeDown = true;
            new Notice(`Claude Code를 실행하지 못해 확인 대기 노트 마무리를 멈췄습니다 (${e.message || e})`, 10000);
          } else if (e instanceof ClaudeRefused) {
            await this.dropMarker(file);
            new Notice(`Claude가 「${name}」을 마무리하지 않아 지금 내용 그대로 둡니다 (${e.message})`, 10000);
          } else {
            new Notice(`「${name}」을 마무리하지 못했습니다. 다음에 다시 시도합니다 (${e.message || e})`, 10000);
          }
          console.error("[link-scrap] Claude 마무리 실패", path, e);
        } finally {
          notice.hide();
        }
      }
    } finally {
      this.pendingBusy = false;
    }
    if (done) new Notice(`Claude 확인 완료: ${done}개`);
  }

  async finishActive() {
    const file = this.app.workspace.getActiveFile();
    if (!file || !parseNote(await this.app.vault.read(file))?.jobs) return new Notice("Claude 확인 대기 표시가 있는 노트를 열어 주세요");
    if (!this.claude()) return new Notice("설정에서 'Claude로 마무리'를 켜 주세요");
    const notice = new Notice(`Claude가 「${file.basename}」을 마무리하는 중…`, 0);
    try {
      const res = await this.finishNote(file, { force: true, say: (m) => notice.setMessage(m) });
      new Notice(res === "done" ? `Claude 확인 완료: ${file.basename}` : "마무리하는 사이에 노트가 바뀌어 저장하지 않았습니다");
    } catch (e) {
      if (e instanceof ClaudeRefused) await this.dropMarker(file);
      new Notice(`마무리하지 못했습니다 (${e.message || e})`, 10000);
    } finally {
      notice.hide();
    }
  }

  /**
   * 표시가 있는 노트를 Claude로 마무리한다. 번역은 원문을 다시 받아 초안을 대조해 고치고, 요약은 원문을 읽고 새로 쓴다.
   * force가 아니면, 초안을 만든 뒤 노트를 고쳤을 때(지문이 다를 때) 덮어쓰지 않는다.
   * @returns {Promise<"done"|"edited"|"none">}
   */
  async finishNote(file, { force = false, say = () => {} } = {}) {
    const runClaude = this.claude();
    if (!runClaude) throw Object.assign(new Error("설정에서 Claude로 마무리가 꺼져 있습니다"), { claudeDown: true });
    // Claude 실행 자체가 실패한 경우를 구분한다 (멈추고 나중에 다시)
    const run = async (prompt, opts) => {
      try {
        return await runClaude(prompt, opts);
      } catch (e) {
        e.claudeDown = true;
        throw e;
      }
    };
    const text = await this.app.vault.read(file);
    const note = parseNote(text);
    if (!note || !note.jobs) return "none";
    if (!force && draftHash(note, note.jobs) !== note.hash) return "edited";

    let { title, body, aliases } = note;
    if (note.jobs.translate || note.jobs.summary) {
      if (!note.url) throw new ClaudeRefused("url이 없습니다");
      say("원문을 다시 가져오는 중…");
      const r = await scrapUrl(note.url, io); // 네트워크 오류는 그대로 던져 다음에 다시 시도
      if (r.kind !== "article" || r.fallback) throw new ClaudeRefused("원문 본문을 찾지 못했습니다");
      say(note.jobs.summary ? "Claude가 요약하는 중…" : "Claude가 번역을 확인하는 중…");
      const progress = (d, n) => n > 1 && say(`Claude가 번역을 확인하는 중… (${d}/${n})`);
      ({ title, markdown: body } = await finishDraft(r, { title, markdown: body }, note.jobs, run, { progress }));
    }
    if (note.jobs.alias && !isKorean(title)) {
      const t = await claudeTitle(title, run);
      aliases = t !== title ? [t] : [];
    }

    const next = buildNote(note, { title, body, aliases: note.jobs.alias ? aliases : null });
    let wrote = false;
    // 마무리하는 사이에 노트를 고쳤으면 저장하지 않는다
    await this.app.vault.process(file, (cur) => {
      if (cur.replace(/\r\n/g, "\n") !== text.replace(/\r\n/g, "\n")) return cur;
      wrote = true;
      return next;
    });
    if (!wrote) return "edited";
    // 제목이 바뀌었으면 파일 이름도 바꾼다 (링크는 옵시디언이 고친다)
    const name = safeFileName(title);
    if (name && name !== file.basename && !file.basename.startsWith(`${name} (`)) {
      const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      await this.app.fileManager.renameFile(file, this.uniquePath(folder, name, "md"));
    }
    return "done";
  }

  // Claude가 마무리하지 않기로 한 노트는 표시만 지운다 (지금 내용 그대로)
  async dropMarker(file) {
    await this.app.vault.process(file, (cur) => {
      const note = parseNote(cur);
      return note && note.jobs ? buildNote(note, { title: note.title, body: note.body, aliases: null }) : cur;
    });
  }

  // 내용을 보고 스크랩 하위 폴더를 고른다. 실패하면 최상위 폴더
  async autoFolder(title, markdown, url) {
    const root = normalizePath(this.settings.rootFolder);
    try {
      const { folder } = suggestFolder(await this.getIndex(), { title, markdown, url }, { root });
      return this.app.vault.getAbstractFileByPath(folder) instanceof TFolder ? folder : root;
    } catch (e) {
      console.error("[link-scrap] 폴더 자동 분류 실패", e);
      return root;
    }
  }

  // 자동 태그·관련 노트. 실패해도 스크랩 자체는 저장되도록 오류를 삼킨다
  async autoSuggest(title, markdown, folder) {
    const s = this.settings;
    if (!s.autoTags && !s.autoLinks) return { tags: [], related: [] };
    try {
      const out = suggest(await this.getIndex(), { title, markdown, folder }, {
        maxRelated: s.maxRelated,
        excludeFolders: [s.rootFolder, ...splitList(s.excludeFolders)],
      });
      return { tags: s.autoTags ? out.tags : [], related: s.autoLinks ? out.related : [] };
    } catch (e) {
      console.error("[link-scrap] 자동 태그·링크 실패", e);
      return { tags: [], related: [] };
    }
  }

  async readClipboard() {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }

  async openModal(prefill) {
    const url = prefill || findUrl(await this.readClipboard()) || "";
    this.whenReady(() => new ScrapModal(this.app, this, url).open());
  }

  scrapFolders() {
    const root = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.rootFolder));
    const out = [];
    const walk = (f) => {
      if (!(f instanceof TFolder)) return;
      out.push(f.path);
      f.children.filter((c) => c instanceof TFolder).sort((a, b) => a.name.localeCompare(b.name)).forEach(walk);
    };
    if (root) walk(root);
    else out.push(this.settings.rootFolder);
    return out;
  }

  findExisting(url) {
    const target = cleanUrl(url);
    return this.app.vault.getMarkdownFiles().find((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      return fm && typeof fm.url === "string" && cleanUrl(fm.url) === target;
    });
  }

  async ensureFolder(path) {
    path = normalizePath(path);
    if (path === "/" || this.app.vault.getAbstractFileByPath(path)) return;
    await this.app.vault.createFolder(path).catch(() => {});
  }

  uniquePath(folder, name, ext) {
    let p = normalizePath(`${folder}/${name}.${ext}`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(p); i++) p = normalizePath(`${folder}/${name} (${i}).${ext}`);
    return p;
  }

  async downloadImages(markdown, noteName) {
    const folder = normalizePath(`${this.settings.imageFolder}/${noteName}`);
    const urls = [...new Set([...markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]))];
    if (!urls.length) return markdown;
    await this.ensureFolder(this.settings.imageFolder);
    await this.ensureFolder(folder);
    let n = 0;
    for (const url of urls) {
      try {
        const res = await requestUrl({ url, headers: { Referer: url }, throw: false });
        if (res.status >= 400 || !res.arrayBuffer.byteLength) continue;
        const ctype = Object.entries(res.headers || {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] || "";
        const path = this.uniquePath(folder, String(++n).padStart(2, "0"), sniffImageExt(res.arrayBuffer, ctype, url));
        await this.app.vault.createBinary(path, res.arrayBuffer);
        // ![설명](원격주소) → ![[Vault 경로]] (기존 노트들과 같은 임베드 형식)
        markdown = markdown.replace(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g, (m, u) => (u === url ? `![[${path}]]` : m));
      } catch {}
    }
    return markdown;
  }

  /**
   * @param {{translate:boolean, summary:boolean}} mode  번역(한국어로) · 요약
   */
  async scrap(url, folder, tags, mode = MODES[0][1]) {
    const existing = this.findExisting(url);
    if (existing) {
      new Notice(`이미 스크랩한 글입니다: ${existing.basename}`);
      if (this.settings.openAfter) this.app.workspace.getLeaf(false).openFile(existing);
      return existing;
    }

    const notice = new Notice("스크랩 중…", 0);
    try {
      const r = await scrapUrl(url, io);
      let title = r.title;
      let markdown = r.markdown || "";
      // 폴더·태그·관련 노트 비교에 쓸 글. 한국어로 옮겼으면 그쪽이 내 노트와 비교하기 좋다
      let matchText = markdown;
      let translated = false;
      const remarks = [];
      const runClaude = this.claude();
      // 나중에 Claude가 마무리할 일 (초안으로 저장한 경우)
      const jobs = { translate: false, summary: false, alias: false };
      if (r.kind === "pdf" && (mode.translate || mode.summary)) remarks.push("PDF는 원문 그대로 저장했습니다");
      if (r.kind === "article" && (mode.translate || mode.summary)) {
        try {
          const t = await transformArticle(r, mode, { post: io.post, runClaude, progress: (m) => notice.setMessage(m) });
          if (t) {
            ({ title, markdown, translated } = t);
            if (translated) matchText = markdown;
            if (t.warning) remarks.push(t.warning);
            // 미리보기만 있는 페이지는 PC에서 다시 받아도 본문이 없으므로 표시하지 않는다
            if (t.retry && !r.fallback) Object.assign(jobs, { translate: t.translated, summary: t.summarized });
          } else if (mode.translate && !r.fallback) {
            remarks.push("한국어 글이라 번역하지 않았습니다");
          }
        } catch (e) {
          remarks.push(`${mode.summary ? "요약" : "번역"}하지 못해 원문으로 저장했습니다 (${e.message || e})`);
          console.error("[link-scrap] 번역·요약 실패", url, e);
        }
      }

      const auto = folder === AUTO_FOLDER;
      if (auto) folder = await this.autoFolder(title, matchText, r.url);
      await this.ensureFolder(folder);
      const name = safeFileName(title);

      let body;
      if (r.kind === "pdf") {
        const pdfPath = this.uniquePath(folder, name, "pdf");
        await this.app.vault.createBinary(pdfPath, r.body);
        body = `![[${pdfPath.split("/").pop()}]]\n`;
      } else {
        body = this.settings.saveImages ? await this.downloadImages(markdown, name) : markdown;
      }

      const sug = await this.autoSuggest(title, matchText, folder);
      tags = [...new Set([...tags.map((t) => t.replace(/^#/, "")), ...sug.tags])];
      const notePath = this.uniquePath(folder, name, "md");
      let aliases = [];
      if (r.kind === "article" && !translated) {
        const al = await this.koreanAliases(title, runClaude);
        aliases = al.aliases;
        jobs.alias = al.pending;
      }

      let fm = `---\nurl: ${yamlValue(r.url)}\n`;
      if (aliases.length) fm += `aliases:\n${aliases.map((a) => `  - ${JSON.stringify(a)}`).join("\n")}\n`;
      if (tags.length) fm += `tags:\n${tags.map((t) => `  - ${yamlValue(t)}`).join("\n")}\n`;
      // 초안이면 PC의 Claude가 마무리하도록 표시한다 (지문: 그 뒤에 노트를 고쳤는지 알아보는 데 쓴다)
      const mark = this.settings.claude && hasJobs(jobs);
      if (mark) fm += markerLine(jobs, draftHash({ title, body, aliases }, jobs)) + "\n";
      if (mark && (jobs.translate || jobs.summary)) {
        remarks.push(Platform.isDesktopApp ? "Claude 확인 대기로 표시해 두었습니다. 나중에 다시 마무리합니다" : "PC 옵시디언에서 Claude가 마무리합니다");
      }
      fm += "---\n";
      // 기존 스크랩과 같은 형식: frontmatter 바로 아래 "관련 노트: [[…]]"
      const links = sug.related
        .map((x) => this.app.vault.getAbstractFileByPath(x.path))
        .filter((f) => f instanceof TFile)
        .map((f) => `[[${this.app.metadataCache.fileToLinktext(f, notePath, true)}]]`);
      const relatedLine = links.length ? `관련 노트: ${links.join(", ")}\n\n` : "";
      const file = await this.app.vault.create(notePath, `${fm}${relatedLine}# ${title}\n\n${body}`);

      // 직접 고른 폴더만 기억한다 (자동 분류 결과는 다음 기본값이 되지 않게)
      if (!auto) {
        this.settings.lastFolder = folder;
        await this.saveData(this.settings);
      }
      notice.hide();
      const extra = [
        auto && `→ ${folder}`,
        tags.length && `태그 ${tags.join(", ")}`,
        links.length && `관련 노트 ${links.length}개`,
      ].filter(Boolean).join(" · ");
      const head = r.fallback ? `본문을 찾지 못해 미리보기만 저장했습니다: ${name}` : `스크랩 완료: ${name}`;
      new Notice([head, extra, ...remarks].filter(Boolean).join("\n"), remarks.length ? 10000 : 6000);
      if (this.settings.openAfter) await this.app.workspace.getLeaf(false).openFile(file);
      return file;
    } catch (e) {
      notice.hide();
      new Notice(`스크랩 실패: ${e.message || e}`, 8000);
      console.error("[link-scrap]", url, e);
    }
  }
}

// 저장 형태 버튼 네 개 (2×2). 누르면 바로 그 형태로 스크랩한다
function addModeButtons(parent, onPick) {
  const grid = parent.createDiv();
  grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;";
  for (const [label, mode] of MODES) {
    const b = grid.createEl("button", { text: label });
    b.style.cssText = "width:100%;height:auto;padding:12px 8px;";
    b.addEventListener("click", () => onPick({ ...mode }));
  }
  return grid;
}

// 공유 단축어·빠른 실행용: 링크는 이미 있으니 저장 형태만 고른다
class ModeModal extends Modal {
  constructor(app, plugin, url, folder, tags) {
    super(app);
    this.plugin = plugin;
    this.url = url;
    this.folder = folder;
    this.tags = tags;
  }

  onOpen() {
    this.titleEl.setText("저장 형태");
    const link = this.contentEl.createDiv({ text: this.url });
    link.style.cssText = "font-size:var(--font-ui-smaller);color:var(--text-muted);word-break:break-all;";
    addModeButtons(this.contentEl, (mode) => this.pick(mode));
  }

  pick(mode) {
    this.close();
    return this.plugin.scrap(this.url, this.folder, this.tags, mode);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ScrapModal extends Modal {
  constructor(app, plugin, url) {
    super(app);
    this.plugin = plugin;
    this.url = url;
    const last = plugin.defaultFolder();
    this.folder = last === AUTO_FOLDER || plugin.scrapFolders().includes(last) ? last : plugin.settings.rootFolder;
    this.tags = "";
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("링크 스크랩");

    let urlInput;
    new Setting(contentEl).setName("링크").addText((t) => {
      urlInput = t;
      t.setPlaceholder("https://…").setValue(this.url).onChange((v) => (this.url = v));
      t.inputEl.style.width = "100%";
    });
    new Setting(contentEl).setName("폴더").addDropdown((d) => {
      d.addOption(AUTO_FOLDER, "자동 분류 (내용 보고 고르기)");
      this.plugin.scrapFolders().forEach((f) => d.addOption(f, f));
      d.setValue(this.folder).onChange((v) => (this.folder = v));
    });
    const tagDesc = this.plugin.settings.autoTags ? "쉼표로 구분. 비워도 자동 태그는 붙음" : "쉼표로 구분, 비워도 됨";
    new Setting(contentEl).setName("태그").setDesc(tagDesc).addText((t) =>
      t.setPlaceholder("AI, 경제/반도체").onChange((v) => (this.tags = v))
    );
    new Setting(contentEl).setName("저장 형태").setDesc("누르면 바로 스크랩합니다. 번역은 한국어로 옮기고, 한국어 글은 번역하지 않습니다.").setHeading();
    addModeButtons(contentEl, (mode) => this.pick(mode));

    // 저장 형태는 매번 직접 고르므로 Enter로는 저장하지 않는다
    contentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && e.target instanceof HTMLInputElement) {
        e.preventDefault();
        new Notice("아래에서 저장 형태를 눌러 주세요");
      }
    });
    // 모바일에서는 키보드가 화면을 가리지 않도록 자동 포커스하지 않는다
    if (!Platform.isMobile) setTimeout(() => urlInput.inputEl.focus(), 0);
  }

  pick(mode) {
    const url = findUrl(this.url);
    if (!url) return new Notice("올바른 링크를 넣어 주세요");
    const tags = this.tags.split(",").map((t) => t.trim()).filter(Boolean);
    this.close();
    return this.plugin.scrap(url, this.folder, tags, mode);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class LinkScrapSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveData(s);
    containerEl.empty();

    new Setting(containerEl)
      .setName("스크랩 최상위 폴더")
      .setDesc("이 폴더와 하위 폴더가 입력창의 폴더 목록에 나옵니다.")
      .addText((t) => t.setValue(s.rootFolder).onChange((v) => ((s.rootFolder = v.trim() || "스크랩"), save())));
    new Setting(containerEl)
      .setName("이미지를 Vault에 저장")
      .setDesc("끄면 원본 사이트의 이미지 주소를 그대로 씁니다(원본이 지워지면 이미지도 사라짐).")
      .addToggle((t) => t.setValue(s.saveImages).onChange((v) => ((s.saveImages = v), save())));
    new Setting(containerEl)
      .setName("이미지 저장 폴더")
      .setDesc("노트 제목별 하위 폴더에 저장합니다.")
      .addText((t) => t.setValue(s.imageFolder).onChange((v) => ((s.imageFolder = v.trim() || "_resources/스크랩"), save())));
    new Setting(containerEl)
      .setName("스크랩 후 노트 열기")
      .addToggle((t) => t.setValue(s.openAfter).onChange((v) => ((s.openAfter = v), save())));

    new Setting(containerEl).setName("자동 분류·태그·관련 노트").setHeading();
    new Setting(containerEl)
      .setName("폴더 자동 분류")
      .setDesc("켜면 입력창의 기본값과 '클립보드 링크 빠른 스크랩'·공유 단축어가 내용과 사이트를 보고 하위 폴더(예: 스크랩/AI)를 고릅니다. 끄면 마지막에 고른 폴더에 저장합니다.")
      .addToggle((t) => t.setValue(s.autoFolder).onChange((v) => ((s.autoFolder = v), save())));
    new Setting(containerEl)
      .setName("태그 자동으로 달기")
      .setDesc("저장할 폴더에서 주로 쓰는 태그, 본문에 이름이 여러 번 나오는 태그, 아주 비슷한 노트의 태그를 붙입니다.")
      .addToggle((t) => t.setValue(s.autoTags).onChange((v) => ((s.autoTags = v), save())));
    new Setting(containerEl)
      .setName("관련 노트 자동으로 링크")
      .setDesc("기본은 끔입니다. 켜면 내용이 비슷하거나 본문에 제목이 나오는 내 노트를 frontmatter 아래 '관련 노트:' 줄에 넣습니다. 스크랩 폴더의 노트끼리는 링크하지 않습니다.")
      .addToggle((t) => t.setValue(s.autoLinks).onChange((v) => ((s.autoLinks = v), save())));
    new Setting(containerEl)
      .setName("관련 노트 최대 개수")
      .addDropdown((d) => {
        ["1", "2", "3", "4", "5"].forEach((n) => d.addOption(n, n));
        d.setValue(String(s.maxRelated)).onChange((v) => ((s.maxRelated = Number(v)), save()));
      });
    new Setting(containerEl)
      .setName("비교에서 뺄 폴더")
      .setDesc("쉼표로 구분. 이 폴더의 노트는 태그·관련 노트 계산에 쓰지 않습니다.")
      .addText((t) =>
        t.setValue(s.excludeFolders).onChange((v) => ((s.excludeFolders = v), (this.plugin.index = null), save()))
      );

    new Setting(containerEl)
      .setName("번역·요약")
      .setDesc("원문/번역 × 전문/요약은 기본값 없이 스크랩할 때마다 고릅니다.")
      .setHeading();
    new Setting(containerEl)
      .setName("외국어 제목에 한국어 별칭 달기")
      .setDesc("원문으로 저장한 외국어 글의 제목을 한국어로 옮겨 aliases에 넣습니다. 한국어로도 검색됩니다.")
      .addToggle((t) => t.setValue(s.koreanAlias).onChange((v) => ((s.koreanAlias = v), save())));

    if (!Platform.isDesktopApp) {
      new Setting(containerEl)
        .setName("PC의 Claude로 마무리")
        .setDesc("휴대폰에서는 구글 번역과 핵심 문장 고르기로 초안을 만들고 노트에 'Claude 확인 대기' 표시를 답니다. PC 옵시디언이 동기화로 이 노트를 받으면 Claude가 번역을 원문과 대조해 고치고, 요약은 원문을 읽고 새로 쓴 뒤 표시를 지웁니다. 그 전에 노트를 고치면 고친 내용을 지키려고 마무리하지 않습니다.")
        .addToggle((t) => t.setValue(s.claude).onChange((v) => ((s.claude = v), save())));
      return;
    }
    new Setting(containerEl)
      .setName("Claude로 마무리")
      .setDesc("이 PC에 설치된 Claude Code를 로그인한 구독 계정으로 실행합니다(API 키 없음, 구독 사용량이 조금 듭니다). 번역은 구글 번역문을 Claude가 원문과 대조해 고치고, 요약은 Claude가 원문을 읽고 씁니다. 휴대폰에서 만든 'Claude 확인 대기' 노트도 동기화되면 마무리합니다. 끄면 구글 번역과 핵심 문장 고르기 결과를 그대로 저장합니다.")
      .addToggle((t) => t.setValue(s.claude).onChange((v) => ((s.claude = v), save(), this.display())));
    if (!s.claude) return;
    new Setting(containerEl)
      .setName("Claude 모델")
      .setDesc("Sonnet(기본)은 더 정확하고, 생각을 덜 해서 번역 확인은 오히려 빠릅니다. Haiku는 구독 사용량이 적게 듭니다.")
      .addDropdown((d) =>
        d.addOption("sonnet", "Sonnet").addOption("haiku", "Haiku")
          .setValue(s.claudeModel)
          .onChange((v) => ((s.claudeModel = v), save()))
      );
    let found = "";
    try {
      found = findClaude(require);
    } catch {}
    new Setting(containerEl)
      .setName("Claude Code 실행 파일")
      .setDesc("비워 두면 기본 설치 위치에서 찾습니다.")
      .addText((t) => t.setPlaceholder(found || "claude").setValue(s.claudePath).onChange((v) => ((s.claudePath = v.trim()), save())));
  }
}
