// 테스트용 최소 obsidian API: 메모리 Vault + fetch 기반 requestUrl + jsdom/turndown
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
td.use(gfm);
globalThis.DOMParser = new JSDOM("").window.DOMParser;

export const Platform = { isMobile: false, isDesktopApp: false };
export const normalizePath = (p) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
export const htmlToMarkdown = (html) => td.turndown(html);
export async function requestUrl({ url, method = "GET", headers = {}, body, contentType }) {
  const res = await fetch(url, { method, headers: contentType ? { ...headers, "Content-Type": contentType } : headers, body });
  const buf = await res.arrayBuffer();
  return { status: res.status, headers: Object.fromEntries(res.headers), arrayBuffer: buf, text: new TextDecoder().decode(buf) };
}

export const notices = (globalThis.__notices ??= []);
export const parseFrontMatterTags = (fm) => {
  const t = fm && fm.tags;
  if (!t) return null;
  return (Array.isArray(t) ? t : String(t).split(/[,s]+/)).filter(Boolean).map((x) => "#" + String(x).replace(/^#/, ""));
};
export const parseFrontMatterAliases = (fm) => {
  const a = fm && (fm.aliases || fm.alias);
  return a ? (Array.isArray(a) ? a : [a]).map(String) : null;
};

export class Notice {
  constructor(msg) {
    notices.push(msg);
  }
  setMessage() {
    return this;
  }
  hide() {}
}

export class TAbstractFile {}
export class TFolder extends TAbstractFile {
  constructor(path) {
    super();
    this.path = path;
    this.name = path.split("/").pop();
    this.children = [];
  }
}
export class TFile extends TAbstractFile {
  constructor(path, data) {
    super();
    this.path = path;
    this.name = path.split("/").pop();
    this.basename = this.name.replace(/\.[^.]+$/, "");
    this.extension = this.name.split(".").pop();
    this.data = data;
  }
}

export class Vault {
  files = new Map();
  getAbstractFileByPath(p) {
    return this.files.get(p) || null;
  }
  parentOf(p) {
    const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    return this.files.get(parent);
  }
  async createFolder(p) {
    if (this.files.has(p)) throw new Error("exists");
    const f = new TFolder(p);
    this.files.set(p, f);
    this.parentOf(p)?.children.push(f);
  }
  async create(p, text) {
    if (this.files.has(p)) throw new Error("exists " + p);
    const f = new TFile(p, text);
    this.files.set(p, f);
    return f;
  }
  async cachedRead(f) {
    return f.data;
  }
  async read(f) {
    return f.data;
  }
  async modify(f, text) {
    f.data = text;
  }
  async process(f, fn) {
    f.data = fn(f.data);
    return f.data;
  }
  async rename(f, p) {
    if (this.files.has(p)) throw new Error("exists " + p);
    this.files.delete(f.path);
    Object.assign(f, new TFile(p, f.data));
    this.files.set(p, f);
  }
  on() {
    return {};
  }
  createBinary(p, buf) {
    return this.create(p, buf);
  }
  getMarkdownFiles() {
    return [...this.files.values()].filter((f) => f instanceof TFile && f.extension === "md");
  }
}

/** 테스트용 frontmatter 읽기: "키: 값"과 "키:\n  - 항목" 목록만 */
export function readFrontmatter(text) {
  const m = typeof text === "string" && text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = {};
  let list = null;
  for (const line of m[1].split("\n")) {
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && list) {
      fm[list].push(item[1].replace(/^"(.*)"$/, "$1"));
      continue;
    }
    const kv = line.match(/^([^:\s][^:]*):\s*(.*)$/);
    if (!kv) continue;
    list = kv[2] ? null : kv[1];
    fm[kv[1]] = kv[2] ? kv[2].replace(/^"(.*)"$/, "$1") : [];
  }
  return fm;
}

/** 테스트용 앱: 메모리 Vault + frontmatter 캐시 + 이름 바꾸기 */
export function makeApp(vault, opened = []) {
  return {
    vault,
    metadataCache: {
      getFileCache: (f) => {
        const frontmatter = readFrontmatter(f.data);
        return frontmatter ? { frontmatter } : {};
      },
      on: () => ({}),
      fileToLinktext: (f) => f.basename,
    },
    fileManager: { renameFile: (f, p) => vault.rename(f, p) },
    workspace: {
      layoutReady: true,
      getLeaf: () => ({ openFile: async (f) => opened.push(f.path) }),
      onLayoutReady: () => {},
      getActiveFile: () => null,
    },
  };
}

export class Plugin {
  constructor(app) {
    this.app = app;
    this.commands = [];
  }
  async loadData() {
    return null;
  }
  async saveData() {}
  addRibbonIcon() {}
  addCommand(c) {
    this.commands.push(c);
  }
  registerObsidianProtocolHandler(name, fn) {
    this.protocol = fn;
  }
  addSettingTab() {}
  registerEvent() {}
}
// ---------- 화면: jsdom 요소에 옵시디언이 붙여 주는 도우미(createDiv 등)를 단다 ----------
const win = new JSDOM("").window;
globalThis.HTMLInputElement = win.HTMLInputElement;
function helpers(e) {
  e.createEl = (tag, o = {}) => {
    const c = helpers(win.document.createElement(tag));
    if (o.text) c.textContent = o.text;
    e.appendChild(c);
    return c;
  };
  e.createDiv = (o = {}) => e.createEl("div", o);
  e.empty = () => (e.innerHTML = "");
  e.setText = (t) => (e.textContent = t);
  e.toggleClass = (c, on) => e.classList.toggle(c, on);
  return e;
}
export const el = (tag = "div") => helpers(win.document.createElement(tag));

// 띄운 창은 목록에 넣기만 한다. 테스트에서 onOpen()으로 그려 보거나 pick을 직접 부른다
export const modals = (globalThis.__modals ??= []);
export class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = el();
    this.titleEl = el();
  }
  open() {
    modals.push(this);
  }
  close() {
    this.closed = true;
  }
}
export class PluginSettingTab {}
export class Setting {
  constructor(parent) {
    this.settingEl = parent.createDiv();
    this.controlEl = this.settingEl.createDiv();
  }
  setName(n) {
    this.settingEl.dataset.name = n;
    return this;
  }
  setDesc() {
    return this;
  }
  setHeading() {
    return this;
  }
  addText(cb) {
    const input = this.controlEl.createEl("input");
    const t = {
      inputEl: input,
      setPlaceholder: () => t,
      setValue: (v) => ((input.value = v), t),
      onChange: (f) => (input.addEventListener("input", () => f(input.value)), t),
    };
    cb(t);
    return this;
  }
  addDropdown(cb) {
    const s = this.controlEl.createEl("select");
    const d = {
      addOption: (v, l) => ((s.createEl("option", { text: l }).value = v), d),
      setValue: (v) => ((s.value = v), d),
      onChange: (f) => (s.addEventListener("change", () => f(s.value)), d),
    };
    cb(d);
    return this;
  }
}
