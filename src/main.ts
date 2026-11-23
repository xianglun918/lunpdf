/**
 * LunPDF — 应用外壳：工具栏、侧栏、快捷键、文件打开、状态记忆。
 */
import "./style.css";
import { PdfViewer, type OutlineNode, type SearchHit } from "./viewer";

const TAURI = "__TAURI_INTERNALS__" in window;

/* ---------------- DOM ---------------- */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const viewportEl = $("viewport");
const pagesEl = $("pages");
const sidebar = $("sidebar");
const docTitle = $("doc-title");
const pageInput = $<HTMLInputElement>("page-input");
const pageTotal = $("page-total");
const zoomLabel = $("btn-zoom-reset");
const welcome = $("welcome");
const loading = $("loading");
const loadingText = $("loading-text");
const toastEl = $("toast");
const dropHint = $("drop-hint");
const paneOutline = $("pane-outline");
const paneSearch = $("pane-search");
const searchInput = $<HTMLInputElement>("search-input");
const searchCount = $("search-count");
const searchResults = $("search-results");
const recentBox = $("recent");
const recentList = $("recent-list");

const viewer = new PdfViewer(viewportEl, pagesEl);

/* ---------------- 状态 ---------------- */
interface LastState {
  path: string;
  name: string;
  page: number;
  scale: number;
  fitMode: "width" | "page" | "custom";
}
interface RecentItem {
  path: string;
  name: string;
  ts: number;
  page: number;
}

const LS = {
  theme: "lunpdf:theme",
  last: "lunpdf:last",
  recent: "lunpdf:recent",
};

const state: { path: string | null; name: string; saveTimer: number | null } = {
  path: null,
  name: "",
  saveTimer: null,
};

const readLS = <T,>(k: string, fb: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fb;
  } catch {
    return fb;
  }
};
const writeLS = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* ignore */
  }
};

/* ---------------- 主题 ---------------- */
function applyTheme(t: "light" | "dark") {
  document.documentElement.dataset.theme = t;
  writeLS(LS.theme, t);
}
function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}
applyTheme((readLS<string>(LS.theme, "light") as "light" | "dark") ?? "light");

/* ---------------- 小工具 ---------------- */
let toastTimer: number | null = null;
function toast(msg: string, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), ms);
}

function showLoading(text = "正在加载…") {
  loadingText.textContent = text;
  loading.classList.remove("hidden");
}
function hideLoading() {
  loading.classList.add("hidden");
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

/* ---------------- 打开文件 ---------------- */
async function pickFile(): Promise<string | null> {
  if (TAURI) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
    });
    return typeof sel === "string" ? sel : null;
  }
  return null;
}

async function readBytes(path: string, file?: File): Promise<Uint8Array> {
  if (TAURI) {
    const { invoke } = await import("@tauri-apps/api/core");
    const buf = await invoke<ArrayBuffer>("read_pdf_file", { path });
    return new Uint8Array(buf);
  }
  if (file) return new Uint8Array(await file.arrayBuffer());
  throw new Error("无法读取文件");
}

function pickFileInBrowser(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

let opening = false;

async function openFile(path: string | null, file?: File) {
  if (opening) return;
  if (!path && !file) return;
  opening = true;
  const displayPath = path || file?.name || "";
  showLoading("正在读取文件…");
  try {
    const bytes = await readBytes(path || "", file);
    showLoading("正在解析 PDF…");
    const last = readLS<LastState | null>(LS.last, null);
    const same = !!last && (last.path === path || (!path && last.name === file?.name));
    await viewer.load(bytes, {
      startPage: same ? last!.page : 1,
      startScale: same && last!.fitMode === "custom" ? last!.scale : undefined,
      fitMode: same ? last!.fitMode : "width",
    });

    state.path = path;
    state.name = file?.name || baseName(displayPath);
    docTitle.textContent = state.name;
    docTitle.classList.remove("empty");
    welcome.classList.add("hidden");
    pageInput.disabled = false;
    pageInput.value = String(viewer.currentPage());
    pageTotal.textContent = String(viewer.numPages);
    setDocTitle(state.name);
    pushRecent(path || state.name, state.name, viewer.currentPage());
    void buildOutline();
    if (sidebarVisible && activeTab === "search") searchInput.focus();
    toast(`已打开 ${state.name} · 共 ${viewer.numPages} 页`);
  } catch (err: any) {
    console.error(err);
    toast(`打开失败：${String(err?.message || err).slice(0, 120)}`, 4000);
  } finally {
    opening = false;
    hideLoading();
  }
}

async function setDocTitle(name: string) {
  if (!TAURI) {
    document.title = name ? `${name} — LunPDF` : "LunPDF";
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(name ? `${name} — LunPDF` : "LunPDF");
  } catch {
    /* ignore */
  }
}

/* ---------------- 最近打开 ---------------- */
function pushRecent(path: string, name: string, page: number) {
  const list = readLS<RecentItem[]>(LS.recent, []).filter((r) => r.path !== path);
  list.unshift({ path, name, ts: Date.now(), page });
  writeLS(LS.recent, list.slice(0, 8));
  renderRecent();
}

function renderRecent() {
  if (!TAURI) return;
  const list = readLS<RecentItem[]>(LS.recent, []);
  if (!list.length) {
    recentBox.classList.add("hidden");
    return;
  }
  recentBox.classList.remove("hidden");
  recentList.replaceChildren();
  for (const r of list) {
    const b = document.createElement("button");
    b.className = "recent-item";
    b.title = r.path;
    const name = document.createElement("span");
    name.className = "ri-name";
    name.textContent = r.name;
    const path = document.createElement("span");
    path.className = "ri-path";
    path.textContent = r.path;
    b.append(name, path);
    b.onclick = () => void openFile(r.path);
    recentList.appendChild(b);
  }
}

/* ---------------- 位置记忆 ---------------- */
function savePosition() {
  if (!viewer.loaded) return;
  const last: LastState = {
    path: state.path || state.name,
    name: state.name,
    page: viewer.currentPage(),
    scale: viewer.scale,
    fitMode: viewer.fitMode,
  };
  writeLS(LS.last, last);
}

function scheduleSavePosition() {
  if (state.saveTimer) window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(savePosition, 600);
}

/* ---------------- 目录 ---------------- */
let outline: OutlineNode[] = [];

async function buildOutline() {
  outline = await viewer.getOutline().catch(() => []);
  paneOutline.replaceChildren();
  if (!outline.length) {
    const d = document.createElement("div");
    d.className = "ol-empty";
    d.textContent = "此文档没有目录";
    paneOutline.appendChild(d);
    return;
  }
  for (const node of outline) {
    const b = document.createElement("button");
    b.className = "ol-item";
    b.style.paddingLeft = `${14 + node.depth * 13}px`;
    b.textContent = node.title;
    if (node.page) {
      const p = document.createElement("span");
      p.className = "ol-page";
      p.textContent = String(node.page);
      b.appendChild(p);
    }
    b.onclick = () => {
      if (node.page) viewer.goToPage(node.page);
    };
    b.dataset.page = String(node.page ?? "");
    paneOutline.appendChild(b);
  }
  markOutlineActive();
}

function markOutlineActive() {
  const cur = viewer.currentPage();
  let active: HTMLElement | null = null;
  for (const el of Array.from(paneOutline.querySelectorAll<HTMLElement>(".ol-item"))) {
    const p = Number(el.dataset.page || 0);
    el.classList.toggle("active", p > 0 && p <= cur);
    if (p > 0 && p <= cur) active = el;
  }
  if (active) active.scrollIntoView({ block: "nearest" });
}

/* ---------------- 侧栏 ---------------- */
let sidebarVisible = false;
let activeTab: "outline" | "search" = "outline";

function setSidebar(show: boolean, tab?: "outline" | "search") {
  sidebarVisible = show;
  sidebar.classList.toggle("hidden", !show);
  if (tab) switchTab(tab);
  if (show) {
    if (activeTab === "search") setTimeout(() => searchInput.focus(), 40);
    setTimeout(() => viewer.applyFit(), 0);
    setTimeout(() => viewer.renderVisible(), 60);
  } else {
    setTimeout(() => {
      viewer.applyFit();
      viewer.renderVisible();
    }, 0);
  }
}

function switchTab(tab: "outline" | "search") {
  activeTab = tab;
  for (const b of Array.from(document.querySelectorAll<HTMLElement>(".side-tab"))) {
    b.classList.toggle("active", b.dataset.tab === tab);
  }
  paneOutline.classList.toggle("hidden", tab !== "outline");
  paneSearch.classList.toggle("hidden", tab !== "search");
  if (tab === "search") setTimeout(() => searchInput.focus(), 30);
}

/* ---------------- 搜索 ---------------- */
let hits: SearchHit[] = [];
let currentHit = -1;
let searchToken = 0;
let searchTimer: number | null = null;

function clearSearch() {
  searchToken++;
  hits = [];
  currentHit = -1;
  viewer.clearAllHighlights();
  searchResults.replaceChildren();
  searchCount.textContent = "";
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = "输入关键词开始搜索";
  searchResults.appendChild(d);
}

async function runSearch(q: string) {
  const token = ++searchToken;
  if (!q.trim() || !viewer.loaded) {
    clearSearch();
    return;
  }
  viewer.clearAllHighlights();
  searchResults.replaceChildren();
  const tip = document.createElement("div");
  tip.className = "empty";
  tip.textContent = "正在搜索…";
  searchResults.appendChild(tip);
  searchCount.textContent = "";

  const found = await viewer.search(
    q,
    (done, total) => {
      if (token === searchToken) searchCount.textContent = `${done}/${total}`;
    },
    () => token !== searchToken,
  );
  if (token !== searchToken) return;

  hits = found;
  currentHit = -1;
  searchCount.textContent = found.length ? `${found.length} 处` : "无结果";
  searchResults.replaceChildren();
  if (!found.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "没有找到匹配内容";
    searchResults.appendChild(d);
    return;
  }
  found.forEach((h, i) => {
    const b = document.createElement("button");
    b.className = "sr-item";
    const p = document.createElement("div");
    p.className = "sr-page";
    p.textContent = `第 ${h.page} 页`;
    const t = document.createElement("div");
    t.className = "sr-text";
    t.appendChild(highlightSnippet(h.snippet, q));
    b.append(p, t);
    b.onclick = () => gotoHit(i);
    searchResults.appendChild(b);
  });
  gotoHit(0);
}

function highlightSnippet(snippet: string, q: string): HTMLElement {
  const frag = document.createDocumentFragment();
  const lower = snippet.toLowerCase();
  const ql = q.toLowerCase();
  let from = 0;
  while (true) {
    const pos = lower.indexOf(ql, from);
    if (pos === -1) break;
    if (pos > from) frag.appendChild(document.createTextNode(snippet.slice(from, pos)));
    const m = document.createElement("mark");
    m.textContent = snippet.slice(pos, pos + q.length);
    frag.appendChild(m);
    from = pos + q.length;
  }
  if (from < snippet.length) frag.appendChild(document.createTextNode(snippet.slice(from)));
  return frag as unknown as HTMLElement;
}

function gotoHit(i: number) {
  if (!hits.length) return;
  currentHit = ((i % hits.length) + hits.length) % hits.length;
  const h = hits[currentHit];
  for (const el of Array.from(searchResults.querySelectorAll(".sr-item"))) {
    el.classList.remove("current");
  }
  const el = searchResults.querySelectorAll<HTMLElement>(".sr-item")[currentHit];
  el?.classList.add("current");
  el?.scrollIntoView({ block: "nearest" });
  viewer.goToPage(h.page, false);
  redrawPageHighlights(h.page);
}

let hlToken = 0;

async function redrawPageHighlights(page: number) {
  const token = ++hlToken;
  const cur = currentHit >= 0 ? hits[currentHit] : null;
  const byPage = new Map<number, SearchHit[]>();
  for (const hit of hits) {
    const arr = byPage.get(hit.page) ?? [];
    arr.push(hit);
    byPage.set(hit.page, arr);
  }
  viewer.clearAllHighlights();
  for (const [p, list] of byPage) {
    if (Math.abs(p - page) > 3) continue;
    const all = (await Promise.all(list.map((h) => viewer.hitRects(h.page, h.start, h.end)))).flat();
    const curRects =
      cur && cur.page === p ? await viewer.hitRects(cur.page, cur.start, cur.end) : [];
    if (token !== hlToken) return;
    viewer.renderHighlights(p, all, curRects);
  }
}

/* ---------------- UI 绑定 ---------------- */
function bindUI() {
  $("btn-open").onclick = () => void startOpen();
  $("btn-open-2").onclick = () => void startOpen();
  $("btn-prev").onclick = () => viewer.goToPage(viewer.currentPage() - 1);
  $("btn-next").onclick = () => viewer.goToPage(viewer.currentPage() + 1);
  $("btn-zoom-in").onclick = () => viewer.zoomBy(1.15);
  $("btn-zoom-out").onclick = () => viewer.zoomBy(1 / 1.15);
  $("btn-zoom-reset").onclick = () => viewer.setScale(1, "custom");
  $("btn-fit-width").onclick = () => viewer.applyFit();
  $("btn-outline").onclick = () => setSidebar(!sidebarVisible || activeTab !== "outline", "outline");
  $("btn-search").onclick = () => setSidebar(!sidebarVisible || activeTab !== "search", "search");
  $("btn-theme").onclick = toggleTheme;
  $("side-close").onclick = () => setSidebar(false);

  for (const b of Array.from(document.querySelectorAll<HTMLElement>(".side-tab"))) {
    b.onclick = () => switchTab(b.dataset.tab as "outline" | "search");
  }

  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const n = parseInt(pageInput.value, 10);
      if (!Number.isNaN(n)) viewer.goToPage(n);
      else pageInput.value = String(viewer.currentPage());
      pageInput.blur();
    } else if (e.key === "Escape") {
      pageInput.value = String(viewer.currentPage());
      pageInput.blur();
    }
  });
  pageInput.addEventListener("blur", () => {
    pageInput.value = String(viewer.currentPage());
  });

  searchInput.addEventListener("input", () => {
    if (searchTimer) window.clearTimeout(searchTimer);
    const q = searchInput.value;
    searchTimer = window.setTimeout(() => void runSearch(q), 380);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!hits.length) void runSearch(searchInput.value);
      else gotoHit(currentHit + (e.shiftKey ? -1 : 1));
    } else if (e.key === "Escape") {
      searchInput.blur();
    }
  });

  viewportEl.addEventListener("scroll", scheduleSavePosition, { passive: true });

  document.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA";
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void startOpen();
      return;
    }
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setSidebar(true, "search");
      searchInput.select();
      return;
    }
    if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      viewer.zoomBy(1.15);
      return;
    }
    if (mod && e.key === "-") {
      e.preventDefault();
      viewer.zoomBy(1 / 1.15);
      return;
    }
    if (mod && e.key === "0") {
      e.preventDefault();
      viewer.setScale(1, "custom");
      return;
    }
    if (typing) return;

    switch (e.key) {
      case "ArrowRight":
      case "PageDown":
      case " ":
        e.preventDefault();
        viewer.goToPage(viewer.currentPage() + 1);
        break;
      case "ArrowLeft":
      case "PageUp":
        e.preventDefault();
        viewer.goToPage(viewer.currentPage() - 1);
        break;
      case "Home":
        e.preventDefault();
        viewer.goToPage(1, true);
        break;
      case "End":
        e.preventDefault();
        viewer.goToPage(viewer.numPages, true);
        break;
      case "+":
      case "=":
        viewer.zoomBy(1.15);
        break;
      case "-":
        viewer.zoomBy(1 / 1.15);
        break;
      case "w":
      case "W":
        viewer.fitMode = "width";
        viewer.applyFit();
        break;
      case "d":
      case "D":
        toggleTheme();
        break;
      case "t":
      case "T":
        setSidebar(!sidebarVisible || activeTab !== "outline", "outline");
        break;
      case "Escape":
        if (sidebarVisible) setSidebar(false);
        break;
      default:
        break;
    }
  });
}

async function startOpen() {
  if (TAURI) {
    const p = await pickFile();
    if (p) await openFile(p);
    return;
  }
  const f = await pickFileInBrowser();
  if (f) await openFile(null, f);
}

/* ---------------- viewer 回调 ---------------- */
viewer.onPageChange = (page, total) => {
  pageInput.value = String(page);
  pageTotal.textContent = String(total);
  if (outline.length) markOutlineActive();
};
viewer.onScaleChange = (s) => {
  zoomLabel.textContent = `${Math.round(s * 100)}%`;
};
viewer.onRendered = () => {
  if (hits.length) {
    const cur = viewer.currentPage();
    redrawPageHighlights(cur);
  }
};

/* ---------------- 拖放 ---------------- */
async function setupDragDrop() {
  if (!TAURI) return;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const wv = getCurrentWebview();
  let depth = 0;
  await wv.onDragDropEvent((event) => {
    const p = event.payload as any;
    if (p.type === "enter" || p.type === "over") {
      depth = 1;
      dropHint.classList.remove("hidden");
    } else if (p.type === "leave") {
      depth = 0;
      dropHint.classList.add("hidden");
    } else if (p.type === "drop") {
      depth = 0;
      dropHint.classList.add("hidden");
      const files: string[] = p.paths || [];
      const pdf = files.find((f) => f.toLowerCase().endsWith(".pdf"));
      if (pdf) void openFile(pdf);
      else if (files.length) toast("只支持 PDF 文件");
    }
    void depth;
  });
}

/* ---------------- 启动 ---------------- */
async function boot() {
  bindUI();
  renderRecent();
  void setupDragDrop();

  if (!TAURI) {
    const note = document.createElement("div");
    note.className = "tip";
    note.innerHTML = "浏览器预览模式（拖拽不可用）";
    welcome.appendChild(note);
    // 调试/嵌入用：?url=xxx.pdf 直接打开
    const auto = new URLSearchParams(location.search).get("url");
    if (auto) {
      try {
        showLoading("正在加载示例…");
        const resp = await fetch(auto);
        const buf = new Uint8Array(await resp.arrayBuffer());
        hideLoading();
        await viewer.load(buf, { startPage: 1, fitMode: "width" });
        state.name = auto.split("/").pop() || auto;
        docTitle.textContent = state.name;
        docTitle.classList.remove("empty");
        welcome.classList.add("hidden");
        pageInput.disabled = false;
        pageInput.value = String(viewer.currentPage());
        pageTotal.textContent = String(viewer.numPages);
        void buildOutline();
      } catch (err) {
        hideLoading();
        toast(`示例加载失败：${String(err).slice(0, 80)}`);
      }
    }
  }
}

void boot();
