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
import { transformArticle, finishDraft, claudeTitle, googleTitle, isKorean, ClaudeRefused, translateMarkdown, parseTerms, applyTerms, claudeGlossary } from "./transform.js";
import { findKorean, addAuto, namesPrompt, parseNames, parseEnglish, fanWikisFor, htmlText, fixPrompt, parseFixPairs, replaceName } from "./lookup.js";
import { claudeRunner, findClaude } from "./claude.js";
import { KEY, draftHash, hasJobs, markerLine, parseNote, buildNote, statusLine, reviewLine, REVIEW_KEY } from "./pending.js";
import { LOG_NAME, stamp, doneText, jobName, formatEntry, buildLog } from "./log.js";
import { DEFAULT_REASONS, SCRAP_KINDS, copyReasons, searchTitle, fallbackTitle, tabLine, addTabLine } from "./reasons.js";
import { RS_ID, watchSync } from "./syncnotice.js";
import { watchFiles, reloadPlugin } from "./selfupdate.js";

// 번역 용어집 노트
const TERMS_NAME = "번역 용어집";
const TERMS_TEMPLATE = `# 번역 용어집

번역·요약·별칭을 만들 때 이 표기를 늘 그대로 쓴다. 한 줄에 하나씩 \`- 원래 표기 → 바꿀 표기\`.
왼쪽에 원어를 쓰면 Claude에게 그 표기를 쓰라고 알려 주고, 왼쪽에 잘못 나온 한국어 표기를 쓰면 결과에서 바로 바꾼다.

- カービィ → 커비
- 카비 → 커비
`;

// 승인 목록 (옵시디언 Bases). 승인 체크박스가 꺼진 노트 / 아직 Claude를 기다리는 노트 / 승인한 노트
const REVIEW_BASE = "스크랩 승인";
const reviewBase = (root) => `filters:
  and:
    - file.inFolder(${JSON.stringify(root)})
    - file.ext == "md"
views:
  - type: table
    name: 승인 대기
    filters:
      and:
        - note["${REVIEW_KEY}"] == false
    order:
      - file.name
      - note.${KEY}
      - note.${REVIEW_KEY}
  - type: table
    name: Claude 확인 대기
    filters:
      and:
        - note["${KEY}"].contains("확인 대기")
    order:
      - file.name
      - note.${KEY}
  - type: table
    name: 승인함
    filters:
      and:
        - note["${REVIEW_KEY}"] == true
    order:
      - file.name
      - note.${KEY}
      - note.${REVIEW_KEY}
`;

// 입력창·명령에서 "내용을 보고 폴더 고르기"를 뜻하는 값
const AUTO_FOLDER = "__auto__";

const DEFAULT_SETTINGS = {
  rootFolder: "스크랩",
  lastFolder: "스크랩",
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
  // 탭 보내기: 켜 둔 이유마다 이 폴더의 노트 하나에 한 줄씩 쌓는다 (1.5.0)
  tabFolder: "수집함",
  reasons: DEFAULT_REASONS,
  // Remotely Save 자동 동기화가 시작·끝·실패했을 때 알림 (1.6.0). "mobile": 휴대폰·태블릿만, "all": PC도, "off": 끔
  // PC는 아래쪽 상태 표시줄에 이미 나오므로 기본은 휴대폰·태블릿만
  syncNotice: "mobile",
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

/**
 * 본문에서 이미지를 뺀다: ![설명](주소), 링크 걸린 이미지 [![…](…)](…), ![[…]], <img>.
 * 이미지만 있던 줄은 없애고 빈 줄은 하나로 줄인다. 코드 블록 안은 건드리지 않는다
 */
export function stripImages(md) {
  const IMG = /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)|!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]+\]\]|<img\b[^>]*>/gi;
  // 이미지에 딸린 글: 「이미지 확대」 단추 글자, 뉴스 사진 설명(이메일로 끝나는 줄)과 그 앞의 굵은 사진 제목
  const ZOOM = /^[ \t]*(\*\*|__)?[ \t]*(이미지|사진|그래픽|영상)[ \t]?확대[ \t]*(\*\*|__)?[ \t]*$/;
  const CAPTION = /[\w.-]+@[\w-]+\.[\w.]+[ \t]*$/;
  const BOLD_TITLE = /^[ \t]*(\*\*|__)[^*_\n]{1,80}(\*\*|__)[ \t]*$/;
  // 네이버 뉴스처럼 이미지 바로 아래 기울임꼴로 단 사진 설명 (_사진=… 기자_)
  const ITALIC = /^[ \t]*(_|\*)(?!\1)[^\n]{1,100}[^*_\s]\1[ \t]*$/;
  const plain = (s) => s.replace(/[*_\\]/g, "").replace(/\s+/g, " ").trim();
  const lines = md.split("\n");
  const out = [];
  let fence = null;
  let afterImage = 0; // 이미지 바로 뒤 몇 줄까지 사진 설명을 찾을지
  let alts = []; // 방금 뺀 이미지의 설명 글
  const next = (i) => {
    for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) return lines[j];
    return "";
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence || f) {
      if (fence && f && f[1][0] === fence) fence = null;
      else if (!fence) fence = f[1][0];
      out.push(line);
      continue;
    }
    if (ZOOM.test(line)) continue;
    if (IMG.test(line)) {
      IMG.lastIndex = 0;
      alts = [...line.matchAll(/!\[([^\]]+)\]/g)].map((m) => plain(m[1])).filter(Boolean);
      const rest = line.replace(IMG, "").replace(/[ \t]+$/, "");
      // 이미지만 있던 줄(목록·인용 기호나 「이미지 확대」만 남는 줄 포함)은 통째로 뺀다
      if (rest.replace(/^[ \t]*(?:[-*+]|\d+[.)]|>)?[ \t]*/, "") && !ZOOM.test(rest)) out.push(rest);
      afterImage = 3;
      continue;
    }
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    if (afterImage > 0) {
      afterImage--;
      if (CAPTION.test(line) || ITALIC.test(line) || alts.includes(plain(line))) continue;
      if (BOLD_TITLE.test(line) && CAPTION.test(next(i))) continue;
      afterImage = 0;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export default class LinkScrapPlugin extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    // 이유 목록은 사용자가 고치므로 기본값을 그대로 쓰지 않고 복사한다
    this.settings.reasons = copyReasons(Array.isArray(saved?.reasons) ? saved.reasons : DEFAULT_REASONS);
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
      // &reason=읽을거리&why=… : 고르는 창 없이 그 이유로 보낸다
      const reason = params.reason && this.settings.reasons.find((r) => r.name === params.reason);
      if (reason) return this.sendTab(url, reason, params.why || "");
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
    desktopCommand("recheck-terms", "이 노트 고유명사 정식 표기로 맞추기", async () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) return new Notice("스크랩 노트를 열어 주세요");
      const notice = new Notice(`「${file.basename}」 표기 확인 중…`, 0);
      try {
        const pairs = await this.recheckTerms(file, { say: (m) => notice.setMessage(m) });
        new Notice(pairs.length ? `고친 표기 ${pairs.length}가지: ${pairs.map(([f, t]) => `${f} → ${t}`).join(", ")}` : "고칠 표기가 없습니다", 10000);
      } catch (e) {
        new Notice(`표기를 맞추지 못했습니다 (${e.message || e})`, 10000);
      } finally {
        notice.hide();
      }
    });
    // 휴대폰에서도 열어 Claude가 확인했는지, 무엇을 고쳤는지 본다
    this.addCommand({ id: "open-claude-log", name: "Claude 확인 기록 열기", callback: () => this.openLog() });
    // Claude를 거친 번역·요약을 사용자가 읽고 승인하는 목록 (옵시디언 Bases 표)
    this.addCommand({ id: "open-review", name: "스크랩 승인 목록 열기", callback: () => this.openReview() });
    this.addCommand({ id: "open-terms", name: "번역 용어집 열기", callback: () => this.openTerms() });
    this.addCommand({
      id: "approve-this",
      name: "이 스크랩 승인",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const v = file && this.app.metadataCache.getFileCache(file)?.frontmatter?.[REVIEW_KEY];
        if (v !== false && v !== "false") return false;
        if (!checking) this.app.fileManager.processFrontMatter(file, (fm) => (fm[REVIEW_KEY] = true)).then(() => new Notice(`승인: ${file.basename}`));
        return true;
      },
    });

    // Remotely Save 자동 동기화 알림. Remotely Save가 나중에 켜지거나 다시 켜져도 3초 안에 다시 연결한다
    this.syncWatch = watchSync({
      getPlugin: () => this.app.plugins?.plugins?.[RS_ID],
      notify: (text, ms) => new Notice(text, ms),
      enabled: () => this.settings.syncNotice === "all" || (this.settings.syncNotice === "mobile" && Platform.isMobile),
    });
    this.syncWatch.check();
    this.app.workspace.onLayoutReady(() => {
      this.syncWatch.check();
      this.syncTimer = setInterval(() => {
        this.syncWatch.check();
        this.fileWatch?.check();
      }, 3000);
    });

    // PC: 플러그인 폴더에 새 버전이 설치되면 옵시디언을 다시 켜지 않아도 몇 초 안에 스스로 다시 불러온다
    if (Platform.isDesktopApp && this.manifest?.dir && this.app.vault.adapter?.stat) {
      const stat = async () => {
        const [m, f] = await Promise.all(["main.js", "manifest.json"].map((n) => this.app.vault.adapter.stat(`${this.manifest.dir}/${n}`)));
        return m && f ? `${m.mtime}:${m.size}:${f.mtime}:${f.size}` : null;
      };
      this.fileWatch = watchFiles({
        stat,
        busy: () => !!this.pendingBusy, // Claude가 노트를 마무리하는 중이면 끝난 뒤에
        reload: () => reloadPlugin(this.app.plugins, this.manifest.id),
      });
      await this.fileWatch.check(); // 지금 파일 상태를 기준으로 삼는다
      // 불러온 버전을 적어 두고, 버전이 바뀌어 불렸으면 알린다
      const version = this.manifest.version;
      if (version && this.settings.loadedVersion !== version) {
        if (this.settings.loadedVersion) new Notice(`링크 스크랩 ${this.settings.loadedVersion} → ${version} 업데이트`);
        this.settings.loadedVersion = version;
        await this.saveData(this.settings);
      }
    }
  }

  onunload() {
    clearTimeout(this.startTimer);
    clearTimeout(this.pendingTimer);
    clearInterval(this.syncTimer);
    this.syncWatch?.stop();
  }

  async getIndex() {
    if (this.index) return this.index;
    const excluded = splitList(this.settings.excludeFolders);
    const files = this.app.vault.getMarkdownFiles().filter((f) => !inFolders(f.path, excluded) && f.path !== this.logPath() && f.path !== this.termsPath());
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
    const terms = await this.terms();
    let t = "";
    let pending = true;
    if (runClaude) {
      try {
        t = await claudeTitle(title, runClaude, terms);
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
    t = applyTerms(t, terms);
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
          if (res === "edited") {
            new Notice(`「${name}」은 노트를 고친 흔적이 있어 Claude 확인을 건너뛰었습니다. 노트를 열고 명령 '이 노트 Claude로 마무리'를 실행하면 고친 내용 대신 Claude가 마무리한 내용으로 바뀝니다.`, 15000);
            await this.logFor(file, { kind: "skip" });
          }
        } catch (e) {
          if (e.claudeDown) {
            // Claude Code가 실행되지 않으면 남은 노트도 안 되므로 멈추고, 다음에 옵시디언을 켜거나 명령을 실행할 때 다시 한다
            this.claudeDown = true;
            new Notice(`Claude Code를 실행하지 못해 확인 대기 노트 마무리를 멈췄습니다 (${e.message || e})`, 10000);
            await this.logFor(file, { kind: "later", reason: `Claude Code를 실행하지 못함 (${e.message || e})` });
          } else if (e instanceof ClaudeRefused) {
            await this.dropMarker(file, e.message);
            new Notice(`Claude가 「${name}」을 마무리하지 않아 지금 내용 그대로 둡니다 (${e.message})`, 10000);
          } else {
            new Notice(`「${name}」을 마무리하지 못했습니다. 다음에 다시 시도합니다 (${e.message || e})`, 10000);
            await this.logFor(file, { kind: "later", reason: `${e.message || e}` });
          }
          console.error("[link-scrap] Claude 마무리 실패", path, e);
        } finally {
          notice.hide();
        }
      }
    } finally {
      this.pendingBusy = false;
    }
    if (done) new Notice(`Claude 확인 완료: ${done}개 — 고친 내용은 명령 'Claude 확인 기록 열기'에서 봅니다`, 8000);
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
      if (e instanceof ClaudeRefused) await this.dropMarker(file, e.message);
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
    let r = {};
    if (note.jobs.translate || note.jobs.summary) {
      if (!note.url) throw new ClaudeRefused("url이 없습니다");
      say("원문을 다시 가져오는 중…");
      const a = await this.fetchArticle(note.url); // 네트워크 오류는 그대로 던져 다음에 다시 시도
      if (a.kind !== "article" || a.fallback) throw new ClaudeRefused("원문 본문을 찾지 못했습니다");
      say(note.jobs.summary ? "Claude가 요약하는 중…" : "Claude가 번역을 확인하는 중…");
      const progress = (d, n) => n > 1 && say(`Claude가 번역을 확인하는 중… (${d}/${n})`);
      // 휴대폰에서 구글 번역이 막혀 원문으로 저장된 노트는 여기서 번역 초안부터 만든다
      let draft = { title, markdown: body };
      if (note.jobs.translate && !note.jobs.summary && !isKorean(`${title}\n${body}`)) {
        say("구글 번역 중…");
        draft = await translateMarkdown(a, io.post);
      }
      const terms = note.jobs.translate ? await this.termsFor(a, run, say) : await this.terms();
      r = await finishDraft(a, draft, note.jobs, run, { progress, terms });
      ({ title, markdown: body } = r);
    }
    if (note.jobs.alias && !isKorean(title)) {
      const t = applyTerms(await claudeTitle(title, run, await this.terms()), await this.terms());
      aliases = t !== title ? [t] : [];
    }

    const when = stamp();
    const status = doneText(note.jobs, r, when);
    const review = !!(note.jobs.translate || note.jobs.summary); // 번역·요약은 사용자가 마지막으로 읽고 승인
    const next = buildNote(note, { title, body, aliases: note.jobs.alias ? aliases : null, status, review });
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
    await this.logFor(file, {
      kind: "done",
      when,
      jobs: note.jobs,
      source: "대기 초안 마무리",
      r,
      draft: note.jobs.summary ? note.body : "",
      alias: note.jobs.alias ? { before: note.aliases, after: aliases } : undefined,
    });
    return "done";
  }

  // Claude가 마무리하지 않기로 한 노트는 표시를 "못 함"으로 바꾼다 (지금 내용 그대로)
  async dropMarker(file, reason = "") {
    const when = stamp();
    let jobs = null;
    await this.app.vault.process(file, (cur) => {
      const note = parseNote(cur);
      if (!note || !note.jobs) return cur;
      jobs = note.jobs;
      const status = [`${jobName(jobs)} 못 함`, when, reason].filter(Boolean).join(" · ");
      return buildNote(note, { title: note.title, body: note.body, aliases: null, status, review: !!(jobs.translate || jobs.summary) });
    });
    if (jobs) await this.logFor(file, { kind: "fail", when, jobs, reason: reason || "이유 없음" });
  }

  // ---------- Claude 확인 기록 ----------

  logPath() {
    return normalizePath(`${this.settings.rootFolder || "스크랩"}/${LOG_NAME}.md`);
  }

  // 아직 확인 대기인 노트 목록 (기록 노트 맨 위에 보여 준다)
  // 메타데이터 캐시는 방금 쓴 노트를 늦게 반영하므로, 후보(캐시에 표시가 있는 노트 + 방금 다룬 노트)는 본문을 읽어 확인한다
  async pendingList(touched) {
    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      const v = this.app.metadataCache.getFileCache(f)?.frontmatter?.[KEY];
      return typeof v === "string" && v.includes("확인 대기");
    });
    if (touched instanceof TFile && !files.includes(touched)) files.push(touched);
    const out = [];
    for (const f of files) {
      const jobs = parseNote(await this.app.vault.read(f))?.jobs;
      if (jobs) out.push({ link: `[[${this.app.metadataCache.fileToLinktext(f, this.logPath(), true)}]]`, job: jobName(jobs) });
    }
    return out;
  }

  /** 노트 하나의 기록을 남긴다. o.jobs가 없으면 노트의 확인 대기 표시에서 읽는다 */
  async logFor(file, o) {
    try {
      let jobs = o.jobs;
      if (!jobs) jobs = parseNote(await this.app.vault.read(file))?.jobs || { translate: true };
      const link = `[[${this.app.metadataCache.fileToLinktext(file, this.logPath(), true)}]]`;
      await this.writeLog(formatEntry({ when: stamp(), ...o, jobs, link }), file);
    } catch (e) {
      console.error("[link-scrap] 확인 기록 남기기 실패", e);
    }
  }

  // 기록 노트는 PC만 쓴다 (휴대폰도 쓰면 동기화 충돌이 난다). 한 번에 하나씩 써서 동시에 마무리한 노트가 서로 덮어쓰지 않게 한다
  writeLog(entry, touched) {
    if (!Platform.isDesktopApp) return Promise.resolve();
    this.logQueue = (this.logQueue || Promise.resolve()).then(async () => {
      const path = this.logPath();
      const pending = await this.pendingList(touched);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await this.app.vault.process(file, (cur) => buildLog(cur, entry, pending));
      else {
        await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
        await this.app.vault.create(path, buildLog("", entry, pending));
      }
    }).catch((e) => console.error("[link-scrap] 확인 기록 쓰기 실패", e));
    return this.logQueue;
  }

  async openLog() {
    const path = this.logPath();
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.writeLog(null);
      file = this.app.vault.getAbstractFileByPath(path);
    }
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    else new Notice("아직 기록이 없습니다. PC 옵시디언에서 Claude가 처음 마무리하면 생깁니다");
  }

  // 번역 용어집: 스크랩 폴더의 노트. "- 원래 표기 → 바꿀 표기" 줄을 번역·요약·별칭에 늘 적용한다 (휴대폰에서도 고칠 수 있게 노트로 둔다)
  termsPath() {
    return normalizePath(`${this.settings.rootFolder || "스크랩"}/${TERMS_NAME}.md`);
  }

  async terms() {
    const f = this.app.vault.getAbstractFileByPath(this.termsPath());
    if (!(f instanceof TFile)) return [];
    try {
      return parseTerms(await this.app.vault.cachedRead(f));
    } catch (e) {
      return [];
    }
  }

  // 이미 만든 번역·요약 노트의 고유명사 표기를 정식 표기로 맞춘다 (원문을 다시 받아 정식 표기를 찾고, 노트에서 다르게 쓴 곳만 바꾼다)
  async recheckTerms(file, { say = () => {} } = {}) {
    const run = this.claude();
    if (!run) throw new Error("PC에서 Claude로 마무리가 켜져 있어야 합니다");
    const text = await this.app.vault.read(file);
    const note = parseNote(text);
    if (!note?.url) throw new Error("url 속성이 있는 스크랩 노트가 아닙니다");
    say("원문을 다시 가져오는 중…");
    const a = await this.fetchArticle(note.url);
    if (a.kind !== "article") throw new Error("원문 본문을 찾지 못했습니다");
    const src = `${a.title}\n${a.markdown}`;
    const terms = (await this.termsFor(a, run, say)).filter(([from]) => src.includes(from));
    const body = `# ${note.title}\n\n${note.body}`;
    let pairs = [];
    if (terms.length) {
      say("노트의 표기를 맞추는 중…");
      pairs = parseFixPairs(await run(fixPrompt(body, terms), { system: "Write the entire output in Korean." }), body, terms);
    }
    const counted = pairs.map(([f, t]) => [f, t, body.split(f).length - 1]);
    if (pairs.length) {
      const fix = (s) => pairs.reduce((acc, [f, t]) => replaceName(acc, f, t), s);
      const title = fix(note.title);
      // 내용이 바뀌었으니 승인은 다시 받는다
      const next = buildNote(note, { title, body: fix(note.body), aliases: null, status: null, review: true });
      let wrote = false;
      await this.app.vault.process(file, (cur) => {
        if (cur.replace(/\r\n/g, "\n") !== text.replace(/\r\n/g, "\n")) return cur;
        wrote = true;
        return next;
      });
      if (!wrote) throw new Error("맞추는 사이에 노트가 바뀌어 저장하지 않았습니다");
      const name = safeFileName(title);
      if (name && name !== file.basename) {
        const folder = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
        await this.app.fileManager.renameFile(file, this.uniquePath(folder, name, "md"));
      }
    }
    await this.logFor(file, { kind: "terms", pairs: counted, jobs: { translate: true } });
    return counted;
  }

  // 외국어 글을 번역할 때: 글의 고유명사·게임 용어를 뽑아 한국 정식 표기를 찾고(위키백과 → 웹 검색 → 공식 누리집 비교) 용어집에 더한 뒤 용어집 전체를 돌려준다
  async termsFor(a, run, say = () => {}) {
    const known = await this.terms();
    if (!run || isKorean(`${a.title}\n${a.markdown}`)) return known;
    try {
      say("한국 정식 명칭을 찾는 중…");
      const have = new Set(known.map(([f]) => f));
      // 최근 30일 안에 찾아봤는데 없던 이름은 다시 검색하지 않는다 (구독 사용량 절약)
      const miss = this.settings.termMiss || {};
      const fresh = (n) => !miss[n] || Date.now() - miss[n] > 30 * 86400000;
      const listed = await run(namesPrompt(a), { system: "Output only the requested list." });
      const names = parseNames(listed).filter((n) => !have.has(n) && fresh(n));
      if (!names.length) return known;
      const english = parseEnglish(listed);
      const fan = fanWikisFor(`${a.title}\n${a.markdown}`);
      const getJson = async (url) => JSON.parse((await requestUrl({ url, headers: { "User-Agent": "link-scrap (Obsidian plugin)" } })).text);
      const getText = async (url) => htmlText((await requestUrl({ url, headers: { "User-Agent": USER_AGENT } })).text);
      const search = (prompt) => run(prompt, { tools: "WebSearch", system: "Write the entire output in Korean." });
      const compare = (prompt) => run(prompt, { system: "Write the entire output in Korean." });
      const found = await findKorean(names, { getJson, search, compare, getText, title: a.title, english, fan });
      if (found.missed?.length) {
        for (const n of found.missed) miss[n] = Date.now();
        this.settings.termMiss = miss;
        await this.saveData(this.settings);
      }
      if (!found.length) return known;
      let file = this.app.vault.getAbstractFileByPath(this.termsPath());
      if (!(file instanceof TFile)) {
        await this.ensureFolder(this.settings.rootFolder || "스크랩");
        file = await this.app.vault.create(this.termsPath(), TERMS_TEMPLATE);
      }
      let text = "";
      await this.app.vault.process(file, (cur) => (text = addAuto(cur, found)));
      return parseTerms(text);
    } catch (e) {
      console.error("[link-scrap] 한국 정식 명칭 찾기 실패", e);
      return known;
    }
  }

  async openTerms() {
    let file = this.app.vault.getAbstractFileByPath(this.termsPath());
    if (!(file instanceof TFile)) {
      await this.ensureFolder(this.settings.rootFolder || "스크랩");
      file = await this.app.vault.create(this.termsPath(), TERMS_TEMPLATE);
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  // 승인 목록: 스크랩 폴더의 Bases 파일. 없으면 만든다 (사용자가 고친 파일은 덮어쓰지 않는다)
  async openReview() {
    const root = this.settings.rootFolder || "스크랩";
    const path = normalizePath(`${root}/${REVIEW_BASE}.base`);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      await this.ensureFolder(root);
      file = await this.app.vault.create(path, reviewBase(root));
    }
    await this.app.workspace.getLeaf(false).openFile(file);
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

  // 글을 가져온다. 스크랩에는 이미지 없이 글만 담는다 (사용자 요청, 1.3.2)
  async fetchArticle(url) {
    const r = await scrapUrl(url, io);
    if (r.kind === "article") r.markdown = stripImages(r.markdown || "");
    return r;
  }

  /**
   * @param {{translate:boolean, summary:boolean}} mode  번역(한국어로) · 요약
   */
  /**
   * @param {{open?:boolean, quietKorean?:boolean}} opts  open: 저장 뒤 노트 열기(기본: 설정), quietKorean: 한국어 글이라 번역 안 한 것은 알리지 않음
   */
  async scrap(url, folder, tags, mode = MODES[0][1], opts = {}) {
    const open = opts.open ?? this.settings.openAfter;
    const existing = this.findExisting(url);
    if (existing) {
      new Notice(`이미 스크랩한 글입니다: ${existing.basename}`);
      if (open) this.app.workspace.getLeaf(false).openFile(existing);
      return existing;
    }

    const notice = new Notice("스크랩 중…", 0);
    try {
      const r = await this.fetchArticle(url);
      let title = r.title;
      let markdown = r.markdown || "";
      // 폴더·태그·관련 노트 비교에 쓸 글. 한국어로 옮겼으면 그쪽이 내 노트와 비교하기 좋다
      let matchText = markdown;
      let translated = false;
      const remarks = [];
      const runClaude = this.claude();
      // 나중에 Claude가 마무리할 일 (초안으로 저장한 경우)
      const jobs = { translate: false, summary: false, alias: false };
      // PC에서 Claude가 바로 마무리했거나 거절한 결과 (노트 표시와 기록에 남긴다)
      let claudeDone = null;
      let claudeFail = "";
      if (r.kind === "pdf" && (mode.translate || mode.summary)) remarks.push("PDF는 원문 그대로 저장했습니다");
      if (r.kind === "article" && (mode.translate || mode.summary)) {
        try {
          const terms = mode.translate ? await this.termsFor(r, runClaude, (m) => notice.setMessage(m)) : await this.terms();
          const t = await transformArticle(r, mode, { post: io.post, runClaude, terms, progress: (m) => notice.setMessage(m) });
          if (t) {
            ({ title, markdown } = t);
            translated = t.translated && !t.raw; // raw: 구글 번역이 막혀 원문 그대로
            if (translated) matchText = markdown;
            if (t.warning) remarks.push(t.warning);
            // 미리보기만 있는 페이지는 PC에서 다시 받아도 본문이 없으므로 표시하지 않는다
            if (t.retry && !r.fallback) Object.assign(jobs, { translate: t.translated, summary: t.summarized });
            if (t.done) claudeDone = { jobs: { translate: t.translated, summary: t.summarized }, r: t };
            else if (runClaude && !t.retry && t.warning) claudeFail = t.warning.replace(/^Claude가 /, "");
          } else if (mode.translate && !r.fallback && !opts.quietKorean) {
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
        body = markdown;
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
      const when = stamp();
      const failJobs = { translate: !!mode.translate, summary: !!mode.summary };
      if (mark) fm += markerLine(jobs, draftHash({ title, body, aliases }, jobs)) + "\n";
      else if (claudeDone) fm += statusLine(doneText(claudeDone.jobs, claudeDone.r, when)) + "\n";
      else if (claudeFail) fm += statusLine(`${jobName(failJobs)} 못 함 · ${when}`) + "\n";
      // Claude를 거친 번역·요약은 사용자가 마지막으로 읽고 승인 체크박스를 켠다
      if (!mark && (claudeDone ? claudeDone.jobs.translate || claudeDone.jobs.summary : claudeFail)) fm += reviewLine() + "\n";
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

      if (mark) await this.writeLog(null, file); // 확인 대기 목록만 새로
      else if (claudeDone) await this.logFor(file, { kind: "done", when, jobs: claudeDone.jobs, source: "PC에서 스크랩하며 바로", r: claudeDone.r });
      else if (claudeFail) await this.logFor(file, { kind: "fail", when, jobs: failJobs, reason: claudeFail });
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
      if (open) await this.app.workspace.getLeaf(false).openFile(file);
      return file;
    } catch (e) {
      notice.hide();
      new Notice(`스크랩 실패: ${e.message || e}`, 8000);
      console.error("[link-scrap]", url, e);
    }
  }

  // ---------- 탭 보내기 ----------

  reasonPath(reason) {
    return normalizePath(`${this.settings.tabFolder || "수집함"}/${safeFileName(reason.name) || "이유"}.md`);
  }

  /**
   * 켜 둔 이유의 노트에 한 줄을 더한다. 본문도 저장하는 이유면 먼저 스크랩하고 그 노트를 링크한다.
   * 스크랩이 막히면 링크만이라도 남긴다 (탭을 닫아도 잃지 않게)
   * @returns {Promise<TFile|undefined>} 이유 노트
   */
  async sendTab(url, reason, why = "") {
    url = findUrl(url);
    if (!url) return new Notice("올바른 링크가 아닙니다");
    const path = this.reasonPath(reason);
    const date = stamp().slice(0, 10);
    const existing = this.app.vault.getAbstractFileByPath(path);
    const before = existing instanceof TFile ? await this.app.vault.read(existing) : "";
    if (addTabLine(before, reason.name, "", cleanUrl(url)) === null) {
      new Notice(`이미 「${reason.name}」에 있는 링크입니다. 탭을 닫아도 됩니다`);
      return existing;
    }

    let line = "";
    let link = cleanUrl(url);
    let remark = "";
    if (reason.scrap) {
      const mode = { translate: reason.scrap === "translate", summary: false };
      const note = await this.scrap(url, this.defaultFolder(), [], mode, { open: false, quietKorean: true });
      if (note instanceof TFile) {
        link = cleanUrl(this.app.metadataCache.getFileCache(note)?.frontmatter?.url || link);
        line = tabLine({ url: link, note: this.app.metadataCache.fileToLinktext(note, path, true), why, date });
      } else {
        remark = "본문은 저장하지 못해 링크만 남겼습니다";
      }
    }
    if (!line) {
      let title = searchTitle(url);
      if (!title) {
        const notice = new Notice("제목을 가져오는 중…", 0);
        try {
          const r = await this.fetchArticle(url);
          title = r.fallback && !r.title ? "" : r.title;
          link = cleanUrl(r.url || link);
        } catch (e) {
          console.error("[link-scrap] 탭 제목 가져오기 실패", url, e);
        } finally {
          notice.hide();
        }
      }
      line = tabLine({ title: title || fallbackTitle(url), url: link, why, date });
    }

    let file = this.app.vault.getAbstractFileByPath(path);
    let added = true;
    if (file instanceof TFile) {
      await this.app.vault.process(file, (cur) => {
        const next = addTabLine(cur, reason.name, line, link);
        if (next === null) added = false;
        return next ?? cur;
      });
    } else {
      await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
      file = await this.app.vault.create(path, addTabLine("", reason.name, line, link));
    }
    new Notice(
      [added ? `「${reason.name}」에 넣었습니다. 탭을 닫아도 됩니다` : `이미 「${reason.name}」에 있는 링크입니다. 탭을 닫아도 됩니다`, remark]
        .filter(Boolean)
        .join("\n"),
      remark ? 10000 : 5000
    );
    return file;
  }

  // 창에서 바로 새 이유를 만든다. 같은 이름이 있으면 그것을 쓴다
  async addReason(name) {
    name = (name || "").replace(/\s+/g, " ").trim();
    if (!name) return null;
    let r = this.settings.reasons.find((x) => x.name === name);
    if (!r) {
      r = { name, scrap: "" };
      this.settings.reasons.push(r);
      await this.saveData(this.settings);
    }
    return r;
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

// 공유 단축어·빠른 실행용: 링크는 이미 있으니 어디로 보낼지만 고른다.
// 위: 켜 둔 이유(탭 보내기) — 이유 노트에 한 줄. 아래: 저장 형태 네 개(본문 스크랩)
class ModeModal extends Modal {
  constructor(app, plugin, url, folder, tags) {
    super(app);
    this.plugin = plugin;
    this.url = url;
    this.folder = folder;
    this.tags = tags;
    this.why = "";
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("어디로 보낼까요");
    const link = contentEl.createDiv({ text: this.url });
    link.style.cssText = "font-size:var(--font-ui-smaller);color:var(--text-muted);word-break:break-all;";

    const label = (text) => {
      const h = contentEl.createDiv({ text });
      h.style.cssText = "margin-top:16px;font-weight:var(--font-semibold);";
      return h;
    };
    label("켜 둔 이유");
    const why = contentEl.createEl("input");
    why.type = "text";
    why.placeholder = "이유 한 줄 (비워도 됨)";
    why.style.cssText = "width:100%;margin-top:8px;";
    why.addEventListener("input", () => (this.why = why.value));
    this.reasonGrid = contentEl.createDiv();
    this.drawReasons();

    label("본문 스크랩");
    addModeButtons(contentEl, (mode) => this.pick(mode));
  }

  drawReasons() {
    const grid = this.reasonGrid;
    grid.empty();
    grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;";
    const button = (text, onClick) => {
      const b = grid.createEl("button", { text });
      b.style.cssText = "width:100%;height:auto;padding:12px 8px;";
      b.addEventListener("click", onClick);
      return b;
    };
    for (const r of this.plugin.settings.reasons) button(r.name, () => this.send(r));
    const add = button("+ 새 이유", () => {
      add.remove();
      const row = grid.createDiv();
      row.style.cssText = "grid-column:1 / -1;display:flex;gap:8px;";
      const input = row.createEl("input");
      input.type = "text";
      input.placeholder = "새 이유 이름 (예: 사고 싶은 것)";
      input.style.cssText = "flex:1;min-width:0;";
      const ok = row.createEl("button", { text: "만들고 보내기" });
      ok.addEventListener("click", async () => {
        const r = await this.plugin.addReason(input.value);
        if (!r) return new Notice("이유 이름을 적어 주세요");
        this.send(r);
      });
      input.focus();
    });
  }

  send(reason) {
    this.close();
    return this.plugin.sendTab(this.url, reason, this.why);
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
      .setName("탭 보내기 (켜 둔 이유)")
      .setDesc("빠른 스크랩·공유 창 위쪽의 이유 버튼입니다. 누르면 아래 폴더의 '이유 이름' 노트에 링크가 한 줄(체크박스)로 쌓입니다. 창에서 '+ 새 이유'로 바로 만들 수도 있습니다. 이름을 바꾸면 그다음부터 새 이름의 노트에 쌓입니다.")
      .setHeading();
    new Setting(containerEl)
      .setName("이유 노트 폴더")
      .addText((t) => t.setValue(s.tabFolder).onChange((v) => ((s.tabFolder = v.trim() || "수집함"), save())));
    s.reasons.forEach((r, i) => {
      new Setting(containerEl)
        .addText((t) => t.setValue(r.name).onChange((v) => ((r.name = v.replace(/\s+/g, " ").trim() || r.name), save())))
        .addDropdown((d) => {
          SCRAP_KINDS.forEach(([v, l]) => d.addOption(v, l));
          d.setValue(r.scrap || "").onChange((v) => ((r.scrap = v), save()));
        })
        .addExtraButton((b) =>
          b.setIcon("arrow-up").setTooltip("위로").onClick(async () => {
            if (i === 0) return;
            [s.reasons[i - 1], s.reasons[i]] = [s.reasons[i], s.reasons[i - 1]];
            await save();
            this.display();
          })
        )
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("지우기 (이미 쌓인 노트는 그대로)").onClick(async () => {
            s.reasons.splice(i, 1);
            await save();
            this.display();
          })
        );
    });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("이유 추가").onClick(async () => {
        s.reasons.push({ name: `새 이유 ${s.reasons.length + 1}`, scrap: "" });
        await save();
        this.display();
      })
    );

    new Setting(containerEl).setName("동기화 알림").setHeading();
    new Setting(containerEl)
      .setName("Remotely Save 자동 동기화 알림")
      .setDesc("Remotely Save는 직접 누른 동기화에만 알림을 띄웁니다. 켜면 앱을 켤 때·주기·저장 뒤에 자동으로 도는 동기화도 시작과 끝, 실패를 Remotely Save와 같은 문장으로 알리고 끝에 (링크 스크랩)을 붙입니다. 저장 뒤 동기화는 끝났을 때만 알립니다. PC는 아래쪽 상태 표시줄에 이미 나옵니다.")
      .addDropdown((d) =>
        d.addOption("mobile", "휴대폰·태블릿만").addOption("all", "모든 기기").addOption("off", "끔")
          .setValue(s.syncNotice)
          .onChange((v) => ((s.syncNotice = v), save()))
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
