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
} from "obsidian";
import { scrapUrl, findUrl, cleanUrl, BLOCKED_TITLE } from "./scrap.js";
import { safeFileName, USER_AGENT } from "./extract.js";

const DEFAULT_SETTINGS = {
  rootFolder: "스크랩",
  lastFolder: "스크랩",
  saveImages: false,
  imageFolder: "_resources/스크랩",
  openAfter: true,
};

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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.addRibbonIcon("newspaper", "링크 스크랩", () => this.openModal());
    this.addCommand({ id: "scrap-link", name: "링크 스크랩", callback: () => this.openModal() });
    this.addCommand({
      id: "scrap-clipboard",
      name: "클립보드 링크 바로 스크랩 (마지막 폴더)",
      callback: async () => {
        const url = findUrl(await this.readClipboard());
        if (!url) return new Notice("클립보드에 링크가 없습니다");
        this.scrap(url, this.settings.lastFolder, []);
      },
    });

    // obsidian://scrap?url=...&folder=...&tags=a,b  (모바일 공유 단축어용)
    this.registerObsidianProtocolHandler("scrap", (params) => {
      const url = findUrl(params.url || params.text || "");
      if (!url) return this.openModal();
      const tags = (params.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
      if (params.ask === "1" || params.ask === "true") return this.openModal(url);
      this.scrap(url, params.folder || this.settings.lastFolder, tags);
    });

    this.addSettingTab(new LinkScrapSettingTab(this.app, this));
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
    new ScrapModal(this.app, this, url).open();
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

  async scrap(url, folder, tags) {
    const existing = this.findExisting(url);
    if (existing) {
      new Notice(`이미 스크랩한 글입니다: ${existing.basename}`);
      if (this.settings.openAfter) this.app.workspace.getLeaf(false).openFile(existing);
      return existing;
    }

    const notice = new Notice("스크랩 중…", 0);
    try {
      const r = await scrapUrl(url, io);
      await this.ensureFolder(folder);
      const name = safeFileName(r.title);

      let body;
      if (r.kind === "pdf") {
        const pdfPath = this.uniquePath(folder, name, "pdf");
        await this.app.vault.createBinary(pdfPath, r.body);
        body = `![[${pdfPath.split("/").pop()}]]\n`;
      } else {
        body = this.settings.saveImages ? await this.downloadImages(r.markdown, name) : r.markdown;
      }

      let fm = `---\nurl: ${yamlValue(r.url)}\n`;
      if (tags.length) fm += `tags:\n${tags.map((t) => `  - ${yamlValue(t.replace(/^#/, ""))}`).join("\n")}\n`;
      fm += "---\n";
      const notePath = this.uniquePath(folder, name, "md");
      const file = await this.app.vault.create(notePath, `${fm}# ${r.title}\n\n${body}`);

      this.settings.lastFolder = folder;
      await this.saveData(this.settings);
      notice.hide();
      new Notice(r.fallback ? `본문을 찾지 못해 미리보기만 저장했습니다: ${name}` : `스크랩 완료: ${name}`, 5000);
      if (this.settings.openAfter) await this.app.workspace.getLeaf(false).openFile(file);
      return file;
    } catch (e) {
      notice.hide();
      new Notice(`스크랩 실패: ${e.message || e}`, 8000);
      console.error("[link-scrap]", url, e);
    }
  }
}

class ScrapModal extends Modal {
  constructor(app, plugin, url) {
    super(app);
    this.plugin = plugin;
    this.url = url;
    this.folder = plugin.scrapFolders().includes(plugin.settings.lastFolder)
      ? plugin.settings.lastFolder
      : plugin.settings.rootFolder;
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
      this.plugin.scrapFolders().forEach((f) => d.addOption(f, f));
      d.setValue(this.folder).onChange((v) => (this.folder = v));
    });
    new Setting(contentEl).setName("태그").setDesc("쉼표로 구분, 비워도 됨").addText((t) =>
      t.setPlaceholder("AI, 경제/반도체").onChange((v) => (this.tags = v))
    );
    new Setting(contentEl).addButton((b) => b.setButtonText("스크랩").setCta().onClick(() => this.submit()));

    contentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    // 모바일에서는 키보드가 화면을 가리지 않도록 자동 포커스하지 않는다
    if (!Platform.isMobile) setTimeout(() => urlInput.inputEl.focus(), 0);
  }

  submit() {
    const url = findUrl(this.url);
    if (!url) return new Notice("올바른 링크를 넣어 주세요");
    const tags = this.tags.split(",").map((t) => t.trim()).filter(Boolean);
    this.close();
    this.plugin.scrap(url, this.folder, tags);
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
  }
}
