import {
  getDocument,
  GlobalWorkerOptions,
  PasswordResponses,
  RenderingCancelledException,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist';
import { app, getState, h, message, onFile, setState, toolbar, vscode } from './common';
import './pdf.css';

type Zoom = number | 'fit';
interface State { page: number; zoom: Zoom; offset: number }

interface Page {
  el: HTMLDivElement;
  /** Page size in PDF points at scale 1 */
  w: number;
  h: number;
  proxy?: PDFPageProxy;
  canvas?: HTMLCanvasElement;
  text?: TextLayer;
  task?: RenderTask;
  /** Rendered or rendering */
  on: boolean;
  /** Bumped on every render/release so stale async work can tell it lost */
  gen: number;
}

const CSS_PER_PT = 96 / 72;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const GAP = 12; // must match the page margin in pdf.css

const state = getState<State>({ page: 1, zoom: 'fit', offset: 0 });
let doc: PDFDocumentProxy | undefined;
let loading: PDFDocumentLoadingTask | undefined;
let pages: Page[] = [];
let texts: (string | undefined)[] = [];
let scale = 1; // effective zoom factor (pt -> css px is scale * CSS_PER_PT)
const visible = new Set<number>();
const wanted = new Set<number>();

// ---- UI -------------------------------------------------------------------
const btn = (text: string, title: string, onclick: () => void) =>
  h('button', { className: 'dm-btn', title, onclick }, text);
const pageInput = h('input', { className: 'dm-input pdf-page-input', type: 'text', inputMode: 'numeric', ariaLabel: 'Page number' });
const pageTotal = h('span', { className: 'dm-info' }, '/ 0');
const zoomLabel = h('span', { className: 'dm-info pdf-zoom-label' }, '');
const fitBtn = btn('Fit width', 'Fit width (Ctrl+0)', () => setZoom('fit'));
const searchInput = h('input', { className: 'dm-input pdf-search', type: 'search', placeholder: 'Search…', ariaLabel: 'Search document' });
const searchInfo = h('span', { className: 'dm-info' }, '');
const view = h('div', { className: 'dm-view pdf-view', tabIndex: 0 });
const list = h('div', { className: 'pdf-pages' });

app.replaceChildren(
  toolbar(
    btn('‹', 'Previous page (PageUp)', () => goTo(state.page - 1)),
    btn('›', 'Next page (PageDown)', () => goTo(state.page + 1)),
    pageInput, pageTotal,
    btn('−', 'Zoom out (Ctrl+-)', () => setZoom(scale / 1.2)),
    btn('+', 'Zoom in (Ctrl++)', () => setZoom(scale * 1.2)),
    fitBtn,
    btn('100%', 'Actual size', () => setZoom(1)),
    zoomLabel,
    searchInput, searchInfo,
  ),
  view,
);

pageInput.addEventListener('change', () => goTo(parseInt(pageInput.value, 10) || state.page));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); void search(searchInput.value, e.shiftKey ? -1 : 1); }
});

// ---- Worker: CSP only allows blob: workers, so load the worker file as text -----
let worker: Worker | undefined;
let workerUrl = '';
async function ensureWorker(ext: string): Promise<void> {
  if (worker) return;
  const res = await fetch(`${ext}/out/pdfjs/pdf.worker.min.mjs`);
  if (!res.ok) throw new Error(`Could not load the PDF worker (${res.status})`);
  workerUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
  worker = new Worker(workerUrl, { type: 'module' });
  GlobalWorkerOptions.workerPort = worker;
}

// ---- Layout -----------------------------------------------------------------
function fitScale(): number {
  const avail = view.clientWidth - 2 * GAP;
  const widest = Math.max(...pages.map((p) => p.w));
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, avail / (widest * CSS_PER_PT)));
}

function sizePage(p: Page): void {
  p.el.style.width = `${Math.floor(p.w * scale * CSS_PER_PT)}px`;
  p.el.style.height = `${Math.floor(p.h * scale * CSS_PER_PT)}px`;
}

/** Index of the page at the top of the viewport */
function currentIndex(): number {
  const top = view.scrollTop + 1;
  let lo = 0, hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid].el.offsetTop - GAP <= top) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function saveState(): void {
  if (!pages.length) return;
  const i = currentIndex();
  const el = pages[i].el;
  state.page = i + 1;
  state.offset = Math.max(0, (view.scrollTop - el.offsetTop) / el.offsetHeight);
  setState(state);
  if (document.activeElement !== pageInput) pageInput.value = String(state.page);
}

function scrollToState(): void {
  const p = pages[Math.min(Math.max(state.page, 1), pages.length) - 1];
  // offset 0 = top of the page, with its gap showing above it
  if (p) view.scrollTop = p.el.offsetTop + (state.offset ? state.offset * p.el.offsetHeight : -GAP);
}

function applyZoom(): void {
  scale = state.zoom === 'fit' ? fitScale() : state.zoom;
  zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  fitBtn.setAttribute('aria-pressed', String(state.zoom === 'fit'));
  for (const p of pages) { release(p); sizePage(p); }
  scrollToState();
  update();
}

function setZoom(z: Zoom): void {
  if (!pages.length) return;
  saveState();
  state.zoom = z === 'fit' ? 'fit' : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  applyZoom();
  setState(state);
}

function goTo(n: number): void {
  if (!pages.length) return;
  state.page = Math.min(Math.max(n, 1), pages.length);
  state.offset = 0;
  scrollToState();
  saveState();
}

// ---- Render only visible pages ±1 -----------------------------------------------
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const i = Number((e.target as HTMLElement).dataset.i);
    if (e.isIntersecting) visible.add(i); else visible.delete(i);
  }
  update();
}, { root: view });

function update(): void {
  wanted.clear();
  if (visible.size) {
    const lo = Math.max(0, Math.min(...visible) - 1);
    const hi = Math.min(pages.length - 1, Math.max(...visible) + 1);
    for (let i = lo; i <= hi; i++) wanted.add(i);
  }
  pages.forEach((p, i) => {
    if (wanted.has(i)) { if (!p.on) void render(p, i); } else if (p.on) release(p);
  });
}

function release(p: Page): void {
  p.on = false;
  p.gen++;
  p.task?.cancel();
  p.text?.cancel();
  if (p.canvas) { p.canvas.width = p.canvas.height = 0; }
  p.task = p.text = p.canvas = undefined;
  p.el.replaceChildren();
  p.proxy?.cleanup();
  p.proxy = undefined;
}

async function render(p: Page, i: number): Promise<void> {
  p.on = true;
  const gen = ++p.gen;
  const d = doc!;
  const page = await d.getPage(i + 1);
  if (gen !== p.gen || d !== doc) return;
  p.proxy = page;
  // Correct the placeholder if this page differs from the size guessed up front
  const base = page.getViewport({ scale: 1 });
  if (base.width !== p.w || base.height !== p.h) {
    const anchor = currentIndex(), before = view.scrollTop - pages[anchor].el.offsetTop;
    p.w = base.width; p.h = base.height; sizePage(p);
    view.scrollTop = pages[anchor].el.offsetTop + before;
  }
  const viewport = page.getViewport({ scale: scale * CSS_PER_PT });
  const out = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = h('canvas', { className: 'pdf-canvas' });
  canvas.width = Math.floor(viewport.width * out);
  canvas.height = Math.floor(viewport.height * out);
  const textDiv = h('div', { className: 'textLayer' });
  p.el.style.setProperty('--scale-factor', String(viewport.scale));
  p.el.replaceChildren(canvas, textDiv);
  p.canvas = canvas;
  p.task = page.render({
    canvasContext: canvas.getContext('2d', { alpha: false })!,
    viewport,
    transform: out === 1 ? undefined : [out, 0, 0, out, 0, 0],
  });
  p.text = new TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
  try {
    await Promise.all([p.task.promise, p.text.render(), addLinks(page, p, viewport, gen)]);
    if (gen === p.gen) p.task = undefined;
  } catch (e) {
    if (e instanceof RenderingCancelledException || gen !== p.gen) return;
    console.error(e);
  }
}

/** Overlay http/https/mailto links; everything else in the PDF is ignored */
async function addLinks(page: PDFPageProxy, p: Page, viewport: ReturnType<PDFPageProxy['getViewport']>, gen: number): Promise<void> {
  const annots = await page.getAnnotations({ intent: 'display' });
  if (gen !== p.gen) return;
  for (const a of annots) {
    const href = a.subtype === 'Link' ? (a.url as string | undefined) : undefined;
    if (!href || !/^(https?:|mailto:)/i.test(href)) continue;
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
    const link = h('a', {
      className: 'pdf-link', href, title: href,
      onclick: (e: MouseEvent) => { e.preventDefault(); vscode.postMessage({ command: 'openExternal', href }); },
    });
    link.style.cssText = `left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${Math.abs(x2 - x1)}px;height:${Math.abs(y2 - y1)}px`;
    p.el.append(link);
  }
}

// ---- Search ------------------------------------------------------------------
let lastQuery = '';
async function search(q: string, dir: 1 | -1): Promise<void> {
  const d = doc;
  const needle = q.trim().toLowerCase();
  if (!d || !needle) { searchInfo.textContent = ''; return; }
  if (needle !== lastQuery) searchInfo.textContent = 'Searching…';
  lastQuery = needle;
  for (let i = 0; i < pages.length; i++) {
    if (texts[i] !== undefined) continue;
    const page = await d.getPage(i + 1);
    const tc = await page.getTextContent();
    if (d !== doc) return;
    texts[i] = tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? ' ' : '') : '')).join('').toLowerCase();
    if (!wanted.has(i)) page.cleanup();
  }
  const hits = texts.flatMap((t, i) => (t!.includes(needle) ? [i] : []));
  if (!hits.length) { searchInfo.textContent = 'No matches'; return; }
  const cur = state.page - 1;
  const next = dir === 1
    ? hits.find((i) => i > cur) ?? hits[0]
    : [...hits].reverse().find((i) => i < cur) ?? hits[hits.length - 1];
  searchInfo.textContent = `match on page ${next + 1} (${hits.indexOf(next) + 1} of ${hits.length} pages)`;
  goTo(next + 1);
}

// ---- Load ----------------------------------------------------------------------
async function teardown(): Promise<void> {
  pages.forEach(release);
  io.disconnect();
  visible.clear();
  pages = [];
  texts = [];
  const old = loading;
  doc = loading = undefined;
  await old?.destroy(); // also destroys its PDFDocumentProxy
}

onFile(async ({ src, ext }) => {
  if (pages.length) saveState(); // keep page and zoom across reloads
  await teardown();
  message(view, 'Loading…');
  try {
    await ensureWorker(ext);
    const task = (loading = getDocument({
      url: src,
      disableAutoFetch: true,
      isEvalSupported: false,
      cMapUrl: `${ext}/out/pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${ext}/out/pdfjs/standard_fonts/`,
    }));
    task.onPassword = (_: unknown, reason: number) => {
      void task.destroy();
      message(view, reason === PasswordResponses.INCORRECT_PASSWORD
        ? 'Incorrect password.' : 'This PDF is password-protected. Password-protected PDFs are not supported yet.', true);
    };
    const d = await task.promise;
    if (task !== loading) return void d.destroy();
    doc = d;
    const n = d.numPages;
    // ponytail: >300 pages are sized from page 1 and corrected when rendered; may jump on mixed-size docs
    const sized = n <= 300
      ? await Promise.all(Array.from({ length: n }, (_, i) => d.getPage(i + 1).then((pg) => pg.getViewport({ scale: 1 }))))
      : [(await d.getPage(1)).getViewport({ scale: 1 })];
    if (task !== loading) return;
    pages = Array.from({ length: n }, (_, i) => {
      const vp = sized[i] ?? sized[0];
      const el = h('div', { className: 'pdf-page' });
      el.dataset.i = String(i);
      return { el, w: vp.width, h: vp.height, on: false, gen: 0 };
    });
    texts = new Array(n);
    list.replaceChildren(...pages.map((p) => p.el));
    view.replaceChildren(list);
    pageTotal.textContent = `/ ${n}`;
    applyZoom();
    pages.forEach((p) => io.observe(p.el));
    saveState();
  } catch (e) {
    if (!loading) return; // torn down while loading
    const name = (e as Error)?.name;
    const text = name === 'PasswordException' ? '' // handled by onPassword
      : name === 'InvalidPDFException' ? 'This file is not a valid PDF, or it is damaged.'
      : name === 'MissingPDFException' ? 'The PDF file could not be found.'
      : `Could not open the PDF: ${(e as Error)?.message ?? e}`;
    if (text) message(view, text, true);
  }
});

// ---- Events ---------------------------------------------------------------------
let scrollTimer = 0;
view.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(saveState, 100);
}, { passive: true });

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { if (state.zoom === 'fit' && pages.length) setZoom('fit'); }, 150);
});

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === '+' || e.key === '=')) setZoom(scale * 1.2);
  else if (mod && e.key === '-') setZoom(scale / 1.2);
  else if (mod && e.key === '0') setZoom('fit');
  else if ((e.target as HTMLElement).tagName === 'INPUT') return;
  else if (e.key === 'PageDown') goTo(state.page + 1);
  else if (e.key === 'PageUp') goTo(state.page - (view.scrollTop > pages[state.page - 1]?.el.offsetTop + 1 ? 0 : 1));
  else if (e.key === 'Home') goTo(1);
  else if (e.key === 'End') goTo(pages.length);
  else return;
  e.preventDefault();
});

window.addEventListener('pagehide', () => {
  void teardown();
  worker?.terminate();
  URL.revokeObjectURL(workerUrl);
});
