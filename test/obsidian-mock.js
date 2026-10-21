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
export async function requestUrl({ url, headers = {} }) {
  const res = await fetch(url, { headers });
  const buf = await res.arrayBuffer();
  return { status: res.status, headers: Object.fromEntries(res.headers), arrayBuffer: buf };
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
