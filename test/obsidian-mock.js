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
export class Modal {}
export class PluginSettingTab {}
export class Setting {}
