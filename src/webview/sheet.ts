// Sheet viewer: xlsx, xls, ods (darkmark.sheet) and csv, tsv (darkmark.csv).
// Keeps only the file's ArrayBuffer plus display strings for the active sheet; rows are virtualized.
import * as XLSX from 'xlsx';
import { app, fetchFile, formatBytes, getState, h, message, onFile, setState, toolbar, type FileInfo } from './common';
import { Kind, MAX_COLS, MAX_ROWS, parseDelimited, type Sheet } from './lib/csv';
import './sheet.css';

const ROW_H = 22;
const BUFFER = 50;
const ROWNUM_W = 56;
const DEFAULT_W = 100;

const KIND_CLASS = ['', '', 'sh-num', 'sh-date', 'sh-bool'];

interface ViewState { sheet: string; top: number; left: number }

let state = getState<ViewState>({ sheet: '', top: 0, left: 0 });
let loadId = 0;
const fmt = (n: number) => n.toLocaleString('en-US');
const pad = (n: number) => String(n).padStart(2, '0');

// SheetJS 0.20 returns cell dates with the sheet's wall-clock time in UTC, so read UTC fields
function formatDate(date: Date): string {
  const d = new Date(Math.round(date.getTime() / 1000) * 1000); // serials carry float error (16:16:59.999)
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const [hh, mm, ss] = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  if (!hh && !mm && !ss) return day;
  return `${day} ${pad(hh)}:${pad(mm)}${ss ? ':' + pad(ss) : ''}`;
}

function cellText(c: XLSX.CellObject | undefined): [string, Kind] {
  if (!c || c.v == null || c.t === 'z') return ['', Kind.Empty];
  switch (c.t) {
    case 'n': return [c.w ?? String(c.v), Kind.Num];
    case 'd': return c.v instanceof Date ? [formatDate(c.v), Kind.Date] : [String(c.v), Kind.Text];
    case 'b': return [c.v ? 'TRUE' : 'FALSE', Kind.Bool];
    default: return [c.w ?? String(c.v), Kind.Text];
  }
}

/** Parse one sheet and reduce it to display strings; the workbook is dropped when this returns */
function parseSheet(buf: ArrayBuffer, name: string, csvSep: string | null): Sheet {
  // One extra row beyond header + MAX_ROWS tells us the sheet was cut (CSV never sets !fullref).
  // cellStyles is what makes SheetJS read the column widths (!cols)
  const opts: XLSX.ParsingOptions = { dense: true, sheetRows: MAX_ROWS + 2, cellDates: true, cellStyles: true, sheets: name };
  if (csvSep) return parseDelimited(decodeText(buf), csvSep);
  const wb = XLSX.read(new Uint8Array(buf), { ...opts, type: 'array' });
  const ws = wb.Sheets[name] ?? wb.Sheets[wb.SheetNames[0]];
  const empty: Sheet = { text: [], kind: new Uint8Array(0), rows: 0, cols: 0, widths: [], cutRows: false, cutCols: false };
  if (!ws?.['!ref']) return empty;
  const range = XLSX.utils.decode_range(ws['!ref']);
  const full = ws['!fullref'] ? XLSX.utils.decode_range(ws['!fullref']) : range;
  const data = (ws['!data'] ?? []) as XLSX.CellObject[][];
  const parsed = Math.min(range.e.r + 1, data.length);
  const rows = Math.min(parsed, MAX_ROWS + 1);
  const cols = Math.min(range.e.c + 1, MAX_COLS);
  const text: string[][] = [];
  const kind = new Uint8Array(rows * cols);
  let any = false;
  for (let r = 0; r < rows; r++) {
    const src = data[r] ?? [];
    const n = Math.min(src.length, cols);
    const t: string[] = new Array(n);
    for (let c = 0; c < n; c++) {
      const [v, k] = cellText(src[c]);
      t[c] = v;
      kind[r * cols + c] = k;
      if (k) any = true;
    }
    text.push(t);
  }
  if (!any) return empty;
  const colInfo = ws['!cols'] ?? [];
  const widths = Array.from({ length: cols }, (_, c) => {
    const ci = colInfo[c];
    const px = ci?.hidden ? 0 : ci?.wch ? ci.wch * 7 + 16 : ci?.wpx ?? DEFAULT_W;
    return Math.round(Math.min(Math.max(px, 40), 400));
  });
  return { text, kind, rows, cols, widths, cutRows: parsed > rows || full.e.r > range.e.r, cutCols: full.e.c + 1 > MAX_COLS };
}

function decodeText(buf: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(buf); // TextDecoder strips the BOM by default
}

function sheetNames(buf: ArrayBuffer, csvSep: string | null): string[] {
  if (csvSep) return ['Sheet1'];
  return XLSX.read(new Uint8Array(buf), { type: 'array', bookSheets: true }).SheetNames;
}

function isZip(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  return b[0] === 0x50 && b[1] === 0x4b;
}

async function load(info: FileInfo): Promise<void> {
  const id = ++loadId;
  const ext = info.name.toLowerCase().split('.').pop() ?? '';
  const csvSep = ext === 'tsv' ? '\t' : ext === 'csv' ? ',' : null;
  if (!app.firstChild) message(app, 'Loading…');
  let buf: ArrayBuffer;
  let names: string[];
  try {
    buf = await fetchFile(info.src);
    if (id !== loadId) return;
    if ((ext === 'xlsx' || ext === 'ods') && !isZip(buf)) throw new Error('not a zip');
    names = sheetNames(buf, csvSep);
    if (!names.length) throw new Error('no sheets');
  } catch (e) {
    console.error(e);
    if (id === loadId) message(app, `Could not open ${info.name}: it is not a readable spreadsheet.`, true);
    return;
  }

  const view = h('div', { className: 'dm-view sh-view', tabIndex: 0 });
  view.setAttribute('role', 'grid');
  view.setAttribute('aria-label', info.name);
  const infoSpan = h('span', { className: 'dm-info' });
  const note = h('span', { className: 'sh-note' });
  const tabs = csvSep ? [] : names.map((name) => {
    const b = h('button', { className: 'dm-btn sh-tab', onclick: () => show(name, 0, 0) }, name);
    b.setAttribute('aria-pressed', 'false');
    return b;
  });
  const tabBar = h('div', { className: 'sh-tabs' }, ...tabs);
  tabBar.setAttribute('role', 'group');
  tabBar.setAttribute('aria-label', 'Sheets');
  app.replaceChildren(toolbar(tabBar, infoSpan, note), view);

  let cleanup = () => {};
  const show = (name: string, top: number, left: number) => {
    cleanup();
    tabs.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === name)));
    state = { sheet: name, top, left };
    setState(state);
    let sheet: Sheet;
    try {
      sheet = parseSheet(buf, name, csvSep);
    } catch (e) {
      console.error(e);
      infoSpan.textContent = note.textContent = '';
      message(view, `Could not read the sheet "${name}".`, true);
      return;
    }
    infoSpan.textContent = `${fmt(sheet.rows)} rows × ${fmt(sheet.cols)} columns · ${formatBytes(info.size)}`;
    note.textContent = [sheet.cutRows && `Showing the first ${fmt(MAX_ROWS)} rows`, sheet.cutCols && `Showing the first ${fmt(MAX_COLS)} columns`]
      .filter(Boolean).join(' · ');
    if (!sheet.rows) { message(view, 'This sheet is empty'); return; }
    cleanup = renderGrid(view, sheet, top, left);
  };
  show(names.includes(state.sheet) ? state.sheet : names[0], state.top, state.left);
}

/** Virtualized grid: sticky column letters and row numbers, only visible rows + BUFFER in the DOM */
function renderGrid(view: HTMLElement, s: Sheet, top: number, left: number): () => void {
  view.style.setProperty('--cols', `${ROWNUM_W}px ${s.widths.map((w) => w + 'px').join(' ')}`);
  view.style.setProperty('--row-h', ROW_H + 'px');
  view.setAttribute('aria-rowcount', String(s.rows + 1));
  view.setAttribute('aria-colcount', String(s.cols + 1));

  const head = h('div', { className: 'sh-row sh-head' }, h('div', { className: 'sh-corner' }));
  head.setAttribute('role', 'row');
  head.setAttribute('aria-rowindex', '1');
  for (let c = 0; c < s.cols; c++) {
    const el = h('div', { className: 'sh-colhead' }, XLSX.utils.encode_col(c));
    el.setAttribute('role', 'columnheader');
    head.append(el);
  }
  const win = h('div', { className: 'sh-window' });
  const body = h('div', { className: 'sh-body' }, win);
  body.style.height = s.rows * ROW_H + 'px';
  view.replaceChildren(head, body);

  let start = -1, end = -1, frame = 0;
  const render = () => {
    frame = 0;
    const first = Math.floor(view.scrollTop / ROW_H);
    const last = Math.ceil((view.scrollTop + view.clientHeight) / ROW_H);
    const ns = Math.max(0, first - BUFFER), ne = Math.min(s.rows, last + BUFFER);
    if (ns !== start || ne !== end) {
      start = ns; end = ne;
      win.style.transform = `translateY(${start * ROW_H}px)`;
      const out: HTMLElement[] = [];
      for (let r = start; r < end; r++) out.push(rowEl(s, r));
      win.replaceChildren(...out);
    }
    state.top = view.scrollTop;
    state.left = view.scrollLeft;
    setState(state);
  };
  const onScroll = () => { if (!frame) frame = requestAnimationFrame(render); };
  const ro = new ResizeObserver(onScroll);
  view.addEventListener('scroll', onScroll, { passive: true });
  ro.observe(view);
  view.scrollTop = top;
  view.scrollLeft = left;
  render();
  return () => {
    view.removeEventListener('scroll', onScroll);
    ro.disconnect();
    cancelAnimationFrame(frame);
  };
}

function rowEl(s: Sheet, r: number): HTMLElement {
  const row = h('div', { className: 'sh-row' }, h('div', { className: 'sh-rownum' }, String(r + 1)));
  row.setAttribute('role', 'row');
  row.setAttribute('aria-rowindex', String(r + 2));
  row.firstElementChild!.setAttribute('role', 'rowheader');
  const t = s.text[r];
  for (let c = 0; c < s.cols; c++) {
    const v = t[c] ?? '';
    const el = h('div', { className: 'sh-cell ' + KIND_CLASS[s.kind[r * s.cols + c]] }, v);
    if (v) el.title = v;
    el.setAttribute('role', 'gridcell');
    row.append(el);
  }
  return row;
}

onFile(load);
