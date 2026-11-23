/**
 * PDF 渲染核心：连续滚动、按需渲染、缩放、文本层、搜索高亮。
 * 基于 pdf.js v6（pdfjs-dist legacy build，兼容较旧的 WebView）。
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const P = pdfjsLib as any;
const MAX_CONCURRENT_RENDER = 2;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SearchHit {
  page: number; // 1-based
  start: number; // 页内字符偏移
  end: number;
  snippet: string;
  index: number;
}

export interface OutlineNode {
  title: string;
  page: number | null;
  depth: number;
}

export type FitMode = "width" | "page" | "custom";

interface PageEntry {
  index: number; // 1-based
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textDiv: HTMLDivElement;
  hlDiv: HTMLDivElement;
  cssW: number;
  cssH: number;
  rendered: boolean;
  renderTask: any;
  textRendered: boolean;
  page: any | null;
}

export class PdfViewer {
  private viewportEl: HTMLElement;
  private pagesEl: HTMLElement;
  private doc: any = null;
  private entries: PageEntry[] = [];
  private observer: IntersectionObserver | null = null;
  private alignTimer: number | null = null;

  private queue: PageEntry[] = [];
  private active = 0;

  scale = 1;
  fitMode: FitMode = "width";
  private readonly scaleMin = 0.15;
  private readonly scaleMax = 8;

  onPageChange: (page: number, total: number) => void = () => {};
  onScaleChange: (scale: number) => void = () => {};
  onRendered: () => void = () => {};
  onLoadProgress: (done: number, total: number) => void = () => {};

  constructor(viewportEl: HTMLElement, pagesEl: HTMLElement) {
    this.viewportEl = viewportEl;
    this.pagesEl = pagesEl;
    this.viewportEl.addEventListener("scroll", () => this.onScroll(), { passive: true });
    window.addEventListener("resize", () => {
      if (!this.loaded) return;
      if (this.fitMode !== "custom") this.applyFit();
      else this.renderVisible();
    });
    // 窗口最小化/切到后台时浏览器会暂停 rAF，pdf.js 的渲染会卡住；恢复后补齐
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.loaded) setTimeout(() => this.renderVisible(), 60);
    });
  }

  get numPages(): number {
    return this.doc ? this.doc.numPages : 0;
  }

  get loaded(): boolean {
    return !!this.doc;
  }

  /* ---------------- 加载 ---------------- */

  async load(
    data: Uint8Array,
    opts: { startPage?: number; startScale?: number; fitMode?: FitMode } = {},
  ): Promise<void> {
    this.disposeDocument();
    // 中文等 CJK 文档必须提供 cMap，否则文本层取不到字，搜索/选中会失效
    const assetBase = new URL(".", document.baseURI).href;
    const loadingTask = P.getDocument({
      data,
      isEvalSupported: true,
      useSystemFonts: true,
      disableFontFace: false,
      cMapUrl: assetBase + "cmaps/",
      cMapPacked: true,
      standardFontDataUrl: assetBase + "standard_fonts/",
    });
    this.doc = await loadingTask.promise;

    this.pagesEl.innerHTML = "";
    this.entries = [];
    this.queue = [];
    this.active = 0;

    const first = await this.doc.getPage(1);
    const base = first.getViewport({ scale: 1 });

    this.fitMode = opts.fitMode ?? "width";
    this.scale = clamp(opts.startScale ?? this.computeFitScale(base.width, base.height), this.scaleMin, this.scaleMax);

    for (let i = 1; i <= this.doc.numPages; i++) {
      const el = document.createElement("div");
      el.className = "page-wrap";
      el.dataset.page = String(i);
      const canvas = document.createElement("canvas");
      const hlDiv = document.createElement("div");
      hlDiv.className = "hl-layer";
      const textDiv = document.createElement("div");
      textDiv.className = "textLayer";
      el.append(canvas, hlDiv, textDiv);
      this.pagesEl.appendChild(el);

      const entry: PageEntry = {
        index: i,
        el,
        canvas,
        textDiv,
        hlDiv,
        cssW: base.width * this.scale,
        cssH: base.height * this.scale,
        rendered: false,
        renderTask: null,
        textRendered: false,
        page: i === 1 ? first : null,
      };
      this.sizeEntry(entry, entry.cssW, entry.cssH);
      this.entries.push(entry);
    }

    this.setupObserver();
    await this.calibrate();
    this.onScaleChange(this.scale);

    const start = Math.min(Math.max(opts.startPage ?? 1, 1), this.numPages);
    // 尺寸校准后再定位，否则页码会偏
    this.goToPage(start, true);
    this.notifyPage();
    this.renderVisible();
  }

  private setupObserver() {
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      (items) => {
        for (const it of items) {
          const el = it.target as HTMLElement;
          const entry = this.entries[Number(el.dataset.page) - 1];
          if (!entry) continue;
          if (it.isIntersecting) this.enqueue(entry);
          else this.maybeRelease(entry);
        }
      },
      { root: this.viewportEl, rootMargin: "150% 0px 150% 0px", threshold: 0 },
    );
    for (const e of this.entries) this.observer.observe(e.el);
  }

  /** 逐页拉取真实尺寸（页面可能尺寸不一），分批让出主线程并汇报进度。 */
  private async calibrate() {
    const total = this.entries.length;
    const batch = 40;
    for (let start = 0; start < total; start += batch) {
      const slice = this.entries.slice(start, start + batch);
      await Promise.all(
        slice.map(async (entry) => {
          if (!entry.page) {
            try {
              entry.page = await this.doc.getPage(entry.index);
            } catch {
              return;
            }
          }
          const vp = entry.page.getViewport({ scale: this.scale });
          if (Math.abs(vp.width - entry.cssW) > 1 || Math.abs(vp.height - entry.cssH) > 1) {
            this.sizeEntry(entry, vp.width, vp.height);
            entry.rendered = false;
          }
        }),
      );
      this.onLoadProgress(Math.min(start + batch, total), total);
      if (start + batch < total) await new Promise((r) => setTimeout(r, 0));
    }
  }

  private sizeEntry(entry: PageEntry, w: number, h: number) {
    entry.cssW = w;
    entry.cssH = h;
    const W = Math.round(w);
    const H = Math.round(h);
    entry.el.style.width = `${W}px`;
    entry.el.style.height = `${H}px`;
    entry.canvas.style.width = `${W}px`;
    entry.canvas.style.height = `${H}px`;
    entry.textDiv.style.width = `${W}px`;
    entry.textDiv.style.height = `${H}px`;
    entry.hlDiv.style.width = `${W}px`;
    entry.hlDiv.style.height = `${H}px`;
  }

  /* ---------------- 渲染队列 ---------------- */

  private enqueue(entry: PageEntry) {
    if (entry.rendered || entry.renderTask) return;
    if (this.queue.includes(entry)) return;
    this.queue.push(entry);
    this.pump();
  }

  private pump() {
    while (this.active < MAX_CONCURRENT_RENDER && this.queue.length) {
      const entry = this.queue.shift()!;
      if (entry.rendered) continue;
      this.active++;
      void this.renderPage(entry).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  renderVisible() {
    const vpRect = this.viewportEl.getBoundingClientRect();
    for (const e of this.entries) {
      const r = e.el.getBoundingClientRect();
      if (r.bottom > vpRect.top - vpRect.height * 0.5 && r.top < vpRect.bottom + vpRect.height * 0.5) {
        this.enqueue(e);
      }
    }
  }

  private async renderPage(entry: PageEntry) {
    if (entry.rendered) return;
    if (!entry.page) {
      try {
        entry.page = await this.doc.getPage(entry.index);
      } catch {
        return;
      }
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = entry.page.getViewport({ scale: this.scale });
    const vpHi = entry.page.getViewport({ scale: this.scale * dpr });

    this.sizeEntry(entry, vp.width, vp.height);
    entry.el.dataset.stage = "canvas-start";

    const canvas = entry.canvas;
    canvas.width = Math.floor(vpHi.width);
    canvas.height = Math.floor(vpHi.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const task = entry.page.render({ canvasContext: ctx, viewport: vpHi, intent: "display" });
    entry.renderTask = task;
    try {
      await task.promise;
      entry.rendered = true;
      entry.el.querySelector(".page-placeholder")?.remove();
      entry.el.dataset.stage = "canvas-done";
      await this.renderTextLayer(entry, vp);
      entry.el.dataset.stage = "text-done";
      this.onRendered();
    } catch (err: any) {
      entry.el.dataset.stage = "render-error";
      entry.el.dataset.err = String(err?.name) + ": " + String(err?.message || err);
      if (err?.name !== "RenderingCancelledException") console.warn("render failed", entry.index, err);
    } finally {
      entry.renderTask = null;
    }
  }

  private async renderTextLayer(entry: PageEntry, vp: any) {
    if (entry.textRendered) return;
    entry.textDiv.replaceChildren();
    entry.textDiv.style.setProperty("--total-scale-factor", String(this.scale));
    try {
      const tl = new P.TextLayer({
        textContentSource: entry.page.streamTextContent(),
        container: entry.textDiv,
        viewport: vp,
      });
      await tl.render();
      // pdf.js 会用 CSS round() 表达式覆盖尺寸，这里回写像素值确保对齐
      entry.textDiv.style.width = `${Math.round(vp.width)}px`;
      entry.textDiv.style.height = `${Math.round(vp.height)}px`;
      entry.textDiv.style.setProperty("--total-scale-factor", String(this.scale));
      entry.textRendered = true;
    } catch (err) {
      entry.el.dataset.stage = "text-error";
      entry.el.dataset.err = String(err);
      console.warn("text layer failed", entry.index, err);
    }
  }

  private maybeRelease(entry: PageEntry) {
    if (!entry.rendered || entry.renderTask) return;
    const vpRect = this.viewportEl.getBoundingClientRect();
    const r = entry.el.getBoundingClientRect();
    const far = r.bottom < vpRect.top - vpRect.height || r.top > vpRect.bottom + vpRect.height;
    if (!far) return;
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.rendered = false;
    entry.textRendered = false;
    entry.textDiv.replaceChildren();
    const idx = this.queue.indexOf(entry);
    if (idx >= 0) this.queue.splice(idx, 1);
    if (!entry.el.querySelector(".page-placeholder")) {
      const ph = document.createElement("div");
      ph.className = "page-placeholder";
      ph.textContent = String(entry.index);
      entry.el.appendChild(ph);
    }
  }

  /* ---------------- 缩放 ---------------- */

  private pageBaseSize(): { w: number; h: number } {
    const e = this.entries[0];
    if (!e) return { w: 595, h: 842 };
    return { w: e.cssW / this.scale, h: e.cssH / this.scale };
  }

  computeFitScale(bw = 0, bh = 0): number {
    const padding = 28;
    const vw = this.viewportEl.clientWidth - padding;
    const vh = this.viewportEl.clientHeight - padding;
    if (!bw || !bh) {
      const b = this.pageBaseSize();
      bw = b.w;
      bh = b.h;
    }
    if (this.fitMode === "page") return clamp(Math.min(vw / bw, vh / bh), this.scaleMin, this.scaleMax);
    return clamp(vw / bw, this.scaleMin, this.scaleMax);
  }

  applyFit() {
    if (!this.loaded) return;
    const anchor = this.anchor();
    this.setScaleInternal(this.computeFitScale());
    if (anchor) this.restoreAnchor(anchor);
    this.renderVisible();
  }

  setScale(next: number, mode: FitMode = "custom") {
    if (!this.loaded) return;
    const anchor = this.anchor();
    this.fitMode = mode;
    this.setScaleInternal(next);
    if (anchor) this.restoreAnchor(anchor);
    this.renderVisible();
  }

  zoomBy(factor: number) {
    if (!this.loaded) return;
    this.setScale(clamp(this.scale * factor, this.scaleMin, this.scaleMax), "custom");
  }

  setFitMode(mode: FitMode) {
    this.fitMode = mode;
  }

  /** 缩放：先按旧 scale 取基准尺寸，再重排所有占位并作废位图。 */
  private setScaleInternal(next: number) {
    const base = this.pageBaseSize();
    this.scale = clamp(next, this.scaleMin, this.scaleMax);
    for (const e of this.entries) {
      if (e.renderTask) {
        try {
          e.renderTask.cancel();
        } catch {
          /* ignore */
        }
        e.renderTask = null;
      }
      e.rendered = false;
      e.textRendered = false;
      e.canvas.width = 0;
      e.canvas.height = 0;
      e.textDiv.replaceChildren();
      e.hlDiv.replaceChildren();
      this.sizeEntry(e, base.w * this.scale, base.h * this.scale);
    }
    this.queue = [];
    this.onScaleChange(this.scale);
  }

  /* ---------------- 滚动与页码 ---------------- */

  private anchor(): { page: number; ratio: number } | null {
    const top = this.viewportEl.getBoundingClientRect().top;
    for (const e of this.entries) {
      const r = e.el.getBoundingClientRect();
      if (r.bottom > top + 30) {
        const ratio = clamp((top + 30 - r.top) / Math.max(1, r.height), 0, 1);
        return { page: e.index, ratio };
      }
    }
    return null;
  }

  private restoreAnchor(a: { page: number; ratio: number }) {
    const e = this.entries[a.page - 1];
    if (!e) return;
    const top = this.viewportEl.getBoundingClientRect().top;
    const r = e.el.getBoundingClientRect();
    const target = this.viewportEl.scrollTop + (r.top - top) + r.height * a.ratio - 30;
    this.viewportEl.scrollTop = Math.max(0, target);
  }

  private onScroll() {
    this.notifyPage();
    if (this.alignTimer) window.clearTimeout(this.alignTimer);
    this.alignTimer = window.setTimeout(() => this.renderVisible(), 80);
  }

  private notifyPage() {
    const a = this.anchor();
    if (a) this.onPageChange(a.page, this.numPages);
  }

  currentPage(): number {
    return this.anchor()?.page ?? 1;
  }

  pageTop(index1: number): number | null {
    const e = this.entries[index1 - 1];
    if (!e) return null;
    const top = this.viewportEl.getBoundingClientRect().top;
    const r = e.el.getBoundingClientRect();
    return this.viewportEl.scrollTop + (r.top - top);
  }

  goToPage(n: number, instant = false) {
    if (!this.loaded) return;
    const idx = Math.min(Math.max(Math.round(n), 1), this.numPages);
    const y = this.pageTop(idx);
    if (y === null) return;
    this.viewportEl.scrollTo({ top: Math.max(0, y - 10), behavior: instant ? "auto" : "smooth" });
    this.notifyPage();
    window.setTimeout(() => this.renderVisible(), instant ? 0 : 280);
  }

  /* ---------------- 目录 ---------------- */

  async getOutline(): Promise<OutlineNode[]> {
    if (!this.doc) return [];
    let raw: any[] | null = null;
    try {
      raw = await this.doc.getOutline();
    } catch {
      return [];
    }
    if (!raw) return [];
    const out: OutlineNode[] = [];
    const walk = async (items: any[], depth: number) => {
      for (const it of items) {
        let page: number | null = null;
        try {
          let dest = it.dest;
          if (typeof dest === "string") dest = await this.doc.getDestination(dest);
          if (Array.isArray(dest) && dest.length) {
            const ref = dest[0];
            const idx = typeof ref === "number" ? ref : await this.doc.getPageIndex(ref);
            page = idx + 1;
          }
        } catch {
          page = null;
        }
        const title = String(it.title || "").replace(/\s+/g, " ").trim();
        if (title) out.push({ title, page, depth });
        if (it.items?.length) await walk(it.items, depth + 1);
      }
    };
    await walk(raw, 0);
    return out;
  }

  /* ---------------- 文本抽取与搜索 ---------------- */

  private textCache = new Map<number, { text: string; items: { start: number; item: any }[] }>();

  private async pageText(i: number) {
    const cached = this.textCache.get(i);
    if (cached) return cached;
    const entry = this.entries[i - 1];
    const page = entry?.page ?? (await this.doc.getPage(i));
    const tc = await page.getTextContent();
    let text = "";
    const items: { start: number; item: any }[] = [];
    for (const item of tc.items as any[]) {
      if (typeof item.str !== "string") continue;
      items.push({ start: text.length, item });
      text += item.str;
    }
    const rec = { text, items };
    this.textCache.set(i, rec);
    return rec;
  }

  async search(
    query: string,
    onProgress?: (done: number, total: number) => void,
    shouldStop?: () => boolean,
  ): Promise<SearchHit[]> {
    const q = query.trim();
    if (!this.doc || !q) return [];
    const lower = q.toLowerCase();
    const hits: SearchHit[] = [];
    let counter = 0;
    for (let i = 1; i <= this.numPages; i++) {
      if (shouldStop?.()) return hits;
      let rec: { text: string } | null = null;
      try {
        rec = await this.pageText(i);
      } catch {
        rec = null;
      }
      if (rec?.text) {
        const hay = rec.text.toLowerCase();
        let from = 0;
        while (true) {
          const pos = hay.indexOf(lower, from);
          if (pos === -1) break;
          hits.push({
            page: i,
            start: pos,
            end: pos + q.length,
            snippet: makeSnippet(rec.text, pos, q.length),
            index: counter++,
          });
          from = pos + Math.max(1, q.length);
          if (hits.length >= 3000) break;
        }
      }
      onProgress?.(i, this.numPages);
      if (i % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    return hits;
  }

  /** 页内字符区间 → 当前缩放下的矩形（缩放后需重新调用）。 */
  async hitRects(pageNumber: number, start: number, end: number): Promise<Rect[]> {
    if (!this.doc) return [];
    let rec;
    try {
      rec = await this.pageText(pageNumber);
    } catch {
      return [];
    }
    const entry = this.entries[pageNumber - 1];
    if (!entry) return [];
    const page = entry.page ?? (await this.doc.getPage(pageNumber));
    const vp = page.getViewport({ scale: this.scale });
    const rects: Rect[] = [];
    const items = rec.items;
    for (let k = 0; k < items.length; k++) {
      const { start: s, item } = items[k];
      const e = k + 1 < items.length ? items[k + 1].start : Number.MAX_SAFE_INTEGER;
      if (e <= start || s >= end) continue;
      const lo = Math.max(0, start - s);
      const hi = Math.min(item.str.length, end - s);
      if (hi <= lo) continue;
      const r = this.itemRect(item, vp, lo, hi);
      if (r) rects.push(r);
    }
    return rects;
  }

  private itemRect(item: any, vp: any, lo: number, hi: number): Rect | null {
    try {
      const t = P.Util.transform(vp.transform, item.transform);
      const fontH = Math.hypot(t[2], t[3]);
      const total = Math.max(1, item.str.length);
      const fullW = Math.abs(item.width) * vp.scale;
      const left = t[4] + (fullW * lo) / total;
      const width = Math.max(1.5, (fullW * (hi - lo)) / total);
      return { left, top: t[5] - fontH * 0.85, width, height: fontH * 1.06 };
    } catch {
      return null;
    }
  }

  renderHighlights(pageNumber: number, rects: Rect[], current: Rect[] = []) {
    const entry = this.entries[pageNumber - 1];
    if (!entry) return;
    entry.hlDiv.replaceChildren();
    const add = (r: Rect, isCurrent: boolean) => {
      const d = document.createElement("div");
      d.className = isCurrent ? "hl current" : "hl";
      d.style.left = `${r.left}px`;
      d.style.top = `${r.top}px`;
      d.style.width = `${r.width}px`;
      d.style.height = `${r.height}px`;
      entry.hlDiv.appendChild(d);
    };
    for (const r of rects) add(r, false);
    for (const r of current) add(r, true);
  }

  clearAllHighlights() {
    for (const e of this.entries) e.hlDiv.replaceChildren();
  }

  clearSearchCache() {
    this.textCache.clear();
  }

  /* ---------------- 清理 ---------------- */

  disposeDocument() {
    this.observer?.disconnect();
    this.observer = null;
    this.queue = [];
    if (this.doc) {
      try {
        void this.doc.destroy();
      } catch {
        /* ignore */
      }
      this.doc = null;
    }
    this.entries = [];
    this.pagesEl.innerHTML = "";
    this.textCache.clear();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function makeSnippet(text: string, pos: number, len: number): string {
  const pad = 38;
  const s = Math.max(0, pos - pad);
  const e = Math.min(text.length, pos + len + pad);
  let out = text.slice(s, e).replace(/\s+/g, " ").trim();
  if (s > 0) out = "…" + out;
  if (e < text.length) out = out + "…";
  return out;
}
