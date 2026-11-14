// PowerPoint (pptx) viewer. Own PresentationML parser on top of jszip + DOMParser.
// Document content is untrusted: text goes in with textContent only, images come
// from inside the zip as blob URLs, and external relationships never load.
import JSZip from 'jszip';
import {
  app, fetchFile, FileInfo, formatBytes, getState, h, message, onFile, setState, toolbar, vscode,
} from './common';
import './slides.css';

const EMU = 9525; // EMU per CSS px (96 dpi)
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CACHE = 5; // parsed slides kept (LRU)

// ── XML helpers ───────────────────────────────────────────────────────

type El = Element;
const kid = (el: El | null | undefined, name: string): El | null =>
  (el && Array.from(el.children).find((c) => c.localName === name)) || null;
const kids = (el: El | null | undefined, name: string): El[] =>
  el ? Array.from(el.children).filter((c) => c.localName === name) : [];
const at = (el: El | null | undefined, ...names: string[]) =>
  names.reduce<El | null>((e, n) => kid(e, n), el ?? null);
const desc = (el: El | Document, name: string): El[] => Array.from(el.getElementsByTagNameNS('*', name));
const num = (v: string | null | undefined, def: number) => {
  const n = v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
};
const rid = (el: El | null, name: string) => el?.getAttributeNS(R_NS, name) || el?.getAttribute(`r:${name}`) || '';

function parseXml(text: string): El {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Malformed XML part');
  return doc.documentElement;
}

// ── Package parts ─────────────────────────────────────────────────────

interface Rel { type: string; target: string; external: boolean }
interface Part { path: string; root: El; rels: Map<string, Rel> }
interface Theme { colors: Record<string, string>; major: string; minor: string }
interface Slide {
  part: Part; layout: Part | null; master: Part | null; theme: Theme;
  clrMap: Record<string, string>; notes: string[];
}
interface Deck {
  zip: JSZip; width: number; height: number; slides: string[]; defaultText: El | null;
  shared: Map<string, Promise<unknown>>; cache: Map<number, Promise<Slide>>;
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const out = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

async function readRels(zip: JSZip, path: string): Promise<Map<string, Rel>> {
  const i = path.lastIndexOf('/');
  const f = zip.file(`${path.slice(0, i + 1)}_rels/${path.slice(i + 1)}.rels`);
  const rels = new Map<string, Rel>();
  if (!f) return rels;
  for (const r of desc(parseXml(await f.async('string')), 'Relationship')) {
    const external = r.getAttribute('TargetMode') === 'External';
    const target = r.getAttribute('Target') ?? '';
    rels.set(r.getAttribute('Id') ?? '', {
      type: r.getAttribute('Type') ?? '',
      external,
      target: external ? target : resolvePath(path, target),
    });
  }
  return rels;
}

async function loadPart(zip: JSZip, path: string): Promise<Part> {
  const f = zip.file(path);
  if (!f) throw new Error(`Missing part ${path}`);
  return { path, root: parseXml(await f.async('string')), rels: await readRels(zip, path) };
}

const relOfType = (part: Part, type: string) =>
  [...part.rels.values()].find((r) => !r.external && r.type.endsWith(`/${type}`))?.target;

function shared<T>(deck: Deck, key: string, make: () => Promise<T>): Promise<T> {
  if (!deck.shared.has(key)) deck.shared.set(key, make());
  return deck.shared.get(key) as Promise<T>;
}

async function openDeck(zip: JSZip): Promise<Deck> {
  const root = await readRels(zip, '');
  const presPath = [...root.values()].find((r) => r.type.endsWith('/officeDocument'))?.target ?? 'ppt/presentation.xml';
  const pres = await loadPart(zip, presPath);
  const size = at(pres.root, 'sldSz');
  const slides = kids(at(pres.root, 'sldIdLst'), 'sldId')
    .map((s) => pres.rels.get(rid(s, 'id')))
    .filter((r): r is Rel => !!r && !r.external && !!zip.file(r.target))
    .map((r) => r.target);
  return {
    zip, slides,
    width: Math.max(1, num(size?.getAttribute('cx'), 9144000) / EMU),
    height: Math.max(1, num(size?.getAttribute('cy'), 6858000) / EMU),
    defaultText: at(pres.root, 'defaultTextStyle'),
    shared: new Map(), cache: new Map(),
  };
}

function parseTheme(root: El): Theme {
  const colors: Record<string, string> = {};
  for (const c of at(root, 'themeElements', 'clrScheme')?.children ?? []) {
    const v = kid(c, 'srgbClr')?.getAttribute('val') ?? kid(c, 'sysClr')?.getAttribute('lastClr');
    if (v && /^[0-9a-f]{6}$/i.test(v)) colors[c.localName] = v;
  }
  const font = (n: string) => at(root, 'themeElements', 'fontScheme', n, 'latin')?.getAttribute('typeface') || '';
  return { colors, major: font('majorFont'), minor: font('minorFont') };
}

async function loadSlide(deck: Deck, i: number): Promise<Slide> {
  const { zip } = deck;
  const part = await loadPart(zip, deck.slides[i]);
  const sharedPart = (p?: string) => (p ? shared(deck, p, () => loadPart(zip, p)).catch(() => null) : Promise.resolve(null));
  const layout = await sharedPart(relOfType(part, 'slideLayout'));
  const master = layout ? await sharedPart(relOfType(layout, 'slideMaster')) : null;
  const themePath = master && relOfType(master, 'theme');
  const theme = themePath
    ? await shared(deck, themePath, async () => parseTheme((await loadPart(zip, themePath)).root)).catch(() => null)
    : null;
  const clrMap: Record<string, string> = {};
  for (const m of [at(master?.root, 'clrMap'), at(part.root, 'clrMapOvr', 'overrideClrMapping')]) {
    for (const a of m?.attributes ?? []) clrMap[a.name] = a.value;
  }
  let notes: string[] = [];
  const notesPath = relOfType(part, 'notesSlide');
  if (notesPath) {
    try {
      const n = await loadPart(zip, notesPath);
      const body = desc(n.root, 'sp').find((sp) => desc(sp, 'ph')[0]?.getAttribute('type') === 'body');
      notes = kids(at(body, 'txBody'), 'p').map((p) =>
        Array.from(p.children).map((c) => (c.localName === 'br' ? '\n' : at(c, 't')?.textContent ?? '')).join(''));
      while (notes.length && !notes[notes.length - 1].trim()) notes.pop();
    } catch (e) {
      console.warn('Speaker notes skipped', e);
    }
  }
  return { part, layout, master, theme: theme ?? { colors: {}, major: '', minor: '' }, clrMap, notes };
}

/** Parsed slides, LRU of CACHE entries */
function getSlide(deck: Deck, i: number): Promise<Slide> {
  let p = deck.cache.get(i);
  if (p) deck.cache.delete(i);
  else p = loadSlide(deck, i);
  deck.cache.set(i, p);
  if (deck.cache.size > CACHE) deck.cache.delete(deck.cache.keys().next().value!);
  return p;
}

// ── Colors ────────────────────────────────────────────────────────────

/** One render of one slide: owns every blob URL it created */
interface Ctx { deck: Deck; slide: Slide; images: boolean; interactive: boolean; urls: string[]; dead: boolean }

const PRESET: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00',
  gray: '808080', orange: 'FFA500', purple: '800080',
};

function hsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue / 6, s, l];
}

function rgb(hue: number, s: number, l: number): [number, number, number] {
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [f(hue + 1 / 3), f(hue), f(hue - 1 / 3)];
}

// tint and shade work in linear RGB
const lin = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const gamma = (x: number) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** CSS color of the first color child of `parent` (srgbClr, schemeClr, ...), with its modifiers */
function color(parent: El | null, ctx: Ctx): string | undefined {
  for (const c of parent?.children ?? []) {
    const val = c.getAttribute('val') ?? '';
    let hex: string | undefined;
    switch (c.localName) {
      case 'srgbClr': hex = val; break;
      case 'sysClr': hex = c.getAttribute('lastClr') ?? undefined; break;
      case 'prstClr': hex = PRESET[val]; break;
      case 'schemeClr': hex = ctx.slide.theme.colors[ctx.slide.clrMap[val] ?? val]; break;
      case 'scrgbClr':
        hex = ['r', 'g', 'b'].map((k) => Math.round(clamp01(num(c.getAttribute(k), 0) / 100000) * 255)
          .toString(16).padStart(2, '0')).join('');
        break;
      default: continue;
    }
    if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
    let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex!.slice(i, i + 2), 16) / 255);
    let a = 1;
    for (const m of c.children) {
      const v = num(m.getAttribute('val'), NaN) / 100000;
      if (!Number.isFinite(v)) continue;
      if (m.localName === 'lumMod' || m.localName === 'lumOff') {
        const [hh, s, l] = hsl(r, g, b);
        [r, g, b] = rgb(hh, s, clamp01(m.localName === 'lumMod' ? l * v : l + v));
      } else if (m.localName === 'tint') [r, g, b] = [r, g, b].map((x) => gamma(lin(x) * v + 1 - v));
      else if (m.localName === 'shade') [r, g, b] = [r, g, b].map((x) => gamma(lin(x) * v));
      else if (m.localName === 'alpha') a = clamp01(v);
    }
    const ch = (x: number) => Math.round(clamp01(x) * 255);
    return `rgba(${ch(r)}, ${ch(g)}, ${ch(b)}, ${a})`;
  }
  return undefined;
}

/** Theme color by name, for colors the viewer applies itself (links, table styles). Constant input only. */
const schemeColor = (ctx: Ctx, val: string, mods = '') =>
  color(parseXml(`<c xmlns:a="urn:a"><a:schemeClr val="${val}">${mods}</a:schemeClr></c>`), ctx);

/** CSS background for a fill-bearing element (spPr, bgPr, tcPr): string, null = no fill, undefined = not set */
function fill(el: El | null, ctx: Ctx): string | null | undefined {
  for (const c of el?.children ?? []) {
    if (c.localName === 'noFill') return null;
    if (c.localName === 'solidFill') return color(c, ctx);
    if (c.localName === 'gradFill') {
      const stops = kids(at(c, 'gsLst'), 'gs')
        .map((gs) => [color(gs, ctx), num(gs.getAttribute('pos'), 0) / 1000] as const)
        .filter(([col]) => col)
        .map(([col, pos]) => `${col} ${pos}%`);
      if (stops.length < 2) return stops.length ? stops[0].split(' ')[0] : undefined;
      const ang = num(at(c, 'lin')?.getAttribute('ang'), 0) / 60000 + 90;
      return `linear-gradient(${ang}deg, ${stops.join(', ')})`;
    }
  }
  return undefined;
}

/** Color from a p:style reference (fillRef, lnRef, fontRef), when idx is not 0 */
function styleRef(el: El, name: string, ctx: Ctx) {
  const ref = at(el, 'style', name);
  return ref && (name === 'fontRef' || num(ref.getAttribute('idx'), 0) > 0) ? color(ref, ctx) : undefined;
}

// ── Fonts ─────────────────────────────────────────────────────────────

const SUBSTITUTE: Record<string, string> = {
  Calibri: 'Carlito', Cambria: 'Caladea', Arial: 'Liberation Sans', Helvetica: 'Liberation Sans',
  'Times New Roman': 'Liberation Serif', 'Courier New': 'Liberation Mono',
};

function fontFamily(name: string, theme: Theme): string {
  if (name.startsWith('+mj')) name = theme.major;
  else if (name.startsWith('+mn')) name = theme.minor;
  const clean = name.replace(/["\\;{}<>]/g, '').trim();
  const q = (n: string) => `"${n}", `;
  return `${clean ? q(clean) : ''}${SUBSTITUTE[clean] ? q(SUBSTITUTE[clean]) : ''}system-ui, -apple-system, "Segoe UI", sans-serif`;
}

// Common Wingdings bullet glyphs and their Unicode look-alikes
const WINGDINGS: Record<string, string> = { '§': '■', 'Ø': '➢', 'ü': '✓', 'q': '❑', 'v': '❖', 'n': '■', 'l': '●', 'Ÿ': '•', 'à': '➔', 'Ü': '➔' };

// ── Images ────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
};

/** Load an embedded image as a blob URL owned by ctx. False when it can't be shown. */
function loadImage(ctx: Ctx, part: Part, id: string, apply: (url: string) => void): boolean {
  const rel = part.rels.get(id);
  if (!ctx.images || !rel || rel.external) return false; // never load external targets
  const mime = MIME[rel.target.split('.').pop()!.toLowerCase()];
  const f = ctx.deck.zip.file(rel.target);
  if (!mime || !f) return false;
  f.async('arraybuffer').then((bytes) => {
    if (ctx.dead) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    ctx.urls.push(url);
    apply(url);
  }, (e) => console.warn('Image skipped', e));
  return true;
}

// ── Geometry ──────────────────────────────────────────────────────────

interface Rect { x: number; y: number; w: number; h: number }
type Xfrm = Rect & { rot: number; flipH: boolean; flipV: boolean };
type MapRect = (r: Rect) => Rect;

function readXfrm(x: El | null): Xfrm | null {
  const off = at(x, 'off'), ext = at(x, 'ext');
  if (!x || !off || !ext) return null;
  return {
    x: num(off.getAttribute('x'), 0), y: num(off.getAttribute('y'), 0),
    w: Math.max(0, num(ext.getAttribute('cx'), 0)), h: Math.max(0, num(ext.getAttribute('cy'), 0)),
    rot: num(x.getAttribute('rot'), 0) / 60000,
    flipH: x.getAttribute('flipH') === '1', flipV: x.getAttribute('flipV') === '1',
  };
}

/** Absolutely positioned box for a shape, in slide px */
function place(el: HTMLElement, xf: Xfrm, map: MapRect, flip = true): HTMLElement {
  const r = map(xf);
  Object.assign(el.style, {
    left: `${r.x / EMU}px`, top: `${r.y / EMU}px`, width: `${r.w / EMU}px`, height: `${r.h / EMU}px`,
  });
  const t = [
    xf.rot ? `rotate(${xf.rot}deg)` : '',
    flip && xf.flipH ? 'scaleX(-1)' : '',
    flip && xf.flipV ? 'scaleY(-1)' : '',
  ].join(' ').trim();
  if (t) el.style.transform = t;
  return el;
}

function unsupported(label: string, xf: Xfrm, map: MapRect): HTMLElement {
  return place(h('div', { className: 'sl-shape sl-unsupported' }, h('span', {}, label)), xf, map);
}

// ── Placeholders and inheritance ──────────────────────────────────────

interface Ph { type: string; idx: string | null }

const phKind = (type: string) =>
  ['title', 'ctrTitle'].includes(type) ? 'title' : ['dt', 'ftr', 'sldNum', 'hdr'].includes(type) ? type : 'body';

function phOf(shape: El): Ph | null {
  const nv = Array.from(shape.children).find((c) => c.localName.startsWith('nv'));
  const ph = at(nv, 'nvPr', 'ph');
  return ph ? { type: phKind(ph.getAttribute('type') ?? 'obj'), idx: ph.getAttribute('idx') } : null;
}

/** Matching placeholder shape on a layout or master: same idx first, then same type */
function findPh(part: Part | null, ph: Ph): El | null {
  let byType: El | null = null;
  for (const sp of kids(at(part?.root, 'cSld', 'spTree'), 'sp')) {
    const p = phOf(sp);
    if (!p) continue;
    if (ph.idx != null && p.idx === ph.idx) return sp;
    if (!byType && p.type === ph.type) byType = sp;
  }
  return byType;
}

// ── Text ──────────────────────────────────────────────────────────────

type Bullet = { kind: 'none' } | { kind: 'char'; char: string } | { kind: 'num'; type: string; start: number };
interface PP {
  algn?: string; marL?: number; indent?: number; bullet?: Bullet; buColor?: string; buFont?: string;
  spcBef?: El; spcAft?: El; lnSpc?: El;
}
interface RP {
  sz?: number; b?: boolean; i?: boolean; u?: boolean; strike?: boolean; color?: string; font?: string; baseline?: number;
}

const bool = (v: string | null) => (v == null ? undefined : v === '1' || v === 'true');

function readPP(el: El | null, ctx: Ctx, into: PP): void {
  if (!el) return;
  const algn = el.getAttribute('algn');
  if (algn) into.algn = algn;
  const marL = num(el.getAttribute('marL'), NaN), indent = num(el.getAttribute('indent'), NaN);
  if (Number.isFinite(marL)) into.marL = marL;
  if (Number.isFinite(indent)) into.indent = indent;
  for (const c of el.children) {
    switch (c.localName) {
      case 'buNone': into.bullet = { kind: 'none' }; break;
      case 'buChar': into.bullet = { kind: 'char', char: c.getAttribute('char') ?? '•' }; break;
      case 'buAutoNum':
        into.bullet = { kind: 'num', type: c.getAttribute('type') ?? '', start: num(c.getAttribute('startAt'), 1) };
        break;
      case 'buClr': into.buColor = color(c, ctx); break;
      case 'buFont': into.buFont = c.getAttribute('typeface') ?? undefined; break;
      case 'spcBef': case 'spcAft': case 'lnSpc': into[c.localName] = c; break;
    }
  }
}

function readRP(el: El | null, ctx: Ctx, into: RP): void {
  if (!el) return;
  const sz = num(el.getAttribute('sz'), NaN);
  if (sz > 0) into.sz = Math.min(sz / 100, 4000);
  const b = bool(el.getAttribute('b')), i = bool(el.getAttribute('i'));
  if (b != null) into.b = b;
  if (i != null) into.i = i;
  const u = el.getAttribute('u');
  if (u) into.u = u !== 'none';
  const strike = el.getAttribute('strike');
  if (strike) into.strike = strike !== 'noStrike';
  const base = num(el.getAttribute('baseline'), NaN);
  if (Number.isFinite(base)) into.baseline = base / 1000;
  const col = color(at(el, 'solidFill'), ctx);
  if (col) into.color = col;
  const font = at(el, 'latin')?.getAttribute('typeface');
  if (font) into.font = font;
}

/** Space in pt from a spcBef/spcAft element, relative to the font size for spcPct */
const spacing = (el: El | undefined, sz: number) =>
  !el ? 0 : at(el, 'spcPts') ? num(at(el, 'spcPts')!.getAttribute('val'), 0) / 100
    : (num(at(el, 'spcPct')?.getAttribute('val'), 0) / 100000) * sz * 1.2;

function autoNumber(type: string, n: number): string {
  const alpha = (k: number) => String.fromCharCode(97 + ((k - 1) % 26));
  const roman = (k: number) => {
    let out = '';
    for (const [v, s] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as const) {
      while (k >= v) { out += s; k -= v; }
    }
    return out;
  };
  let s = type.startsWith('alpha') ? alpha(n) : type.startsWith('roman') ? roman(n) : String(n);
  if (/Uc/.test(type)) s = s.toUpperCase();
  return type.endsWith('ParenBoth') ? `(${s})` : type.endsWith('ParenR') ? `${s})` : type.endsWith('Plain') ? s : `${s}.`;
}

interface TextOpts {
  styles: (El | null)[]; // inherited list styles, lowest priority first
  base?: RP; // from p:style fontRef or a table style, beats inherited styles
  fontScale: number; lnReduce: number;
}

/** Append the paragraphs of a txBody to `target` */
function renderParagraphs(target: HTMLElement, txBody: El, part: Part, ctx: Ctx, o: TextOpts): void {
  const styles = [ctx.deck.defaultText, ...o.styles];
  const own = at(txBody, 'lstStyle');
  const counters: number[] = [];
  for (const p of kids(txBody, 'p')) {
    const pPr = at(p, 'pPr');
    const lvl = Math.min(8, Math.max(0, num(pPr?.getAttribute('lvl'), 0)));
    const lvlPr = (s: El | null) => at(s, `lvl${lvl + 1}pPr`);
    const pp: PP = {};
    const rpBase: RP = {};
    for (const s of styles) { readPP(lvlPr(s), ctx, pp); readRP(at(lvlPr(s), 'defRPr'), ctx, rpBase); }
    Object.assign(rpBase, o.base);
    readPP(lvlPr(own), ctx, pp); readRP(at(lvlPr(own), 'defRPr'), ctx, rpBase);
    readPP(pPr, ctx, pp); readRP(at(pPr, 'defRPr'), ctx, rpBase);

    const para = h('p');
    const runs = Array.from(p.children).filter((c) => ['r', 'br', 'fld'].includes(c.localName));
    const firstRP: RP = { ...rpBase };
    readRP(at(runs.find((r) => r.localName !== 'br') ?? at(p, 'endParaRPr'), 'rPr') ?? at(p, 'endParaRPr'), ctx, firstRP);
    const sz = (firstRP.sz ?? 18) * o.fontScale;

    para.style.textAlign = ({ ctr: 'center', r: 'right', just: 'justify', dist: 'justify' } as Record<string, string>)[pp.algn ?? ''] ?? 'left';
    para.style.paddingLeft = `${(pp.marL ?? 0) / EMU}px`;
    para.style.textIndent = `${(pp.indent ?? 0) / EMU}px`;
    para.style.fontSize = `${sz}pt`;
    const lnPct = num(at(pp.lnSpc, 'spcPct')?.getAttribute('val'), 100000) / 100000;
    const lnPts = num(at(pp.lnSpc, 'spcPts')?.getAttribute('val'), NaN) / 100;
    para.style.lineHeight = Number.isFinite(lnPts) ? `${lnPts}pt` : String(1.2 * lnPct * (1 - o.lnReduce));
    para.style.marginTop = `${spacing(pp.spcBef, sz)}pt`;
    para.style.marginBottom = `${spacing(pp.spcAft, sz)}pt`;

    // Bullets: only on paragraphs with text
    counters.length = lvl + 1;
    const hasText = runs.some((r) => r.localName !== 'br' && at(r, 't')?.textContent);
    if (hasText && pp.bullet && pp.bullet.kind !== 'none') {
      let glyph: string;
      if (pp.bullet.kind === 'num') {
        counters[lvl] = (counters[lvl] ?? pp.bullet.start - 1) + 1;
        glyph = autoNumber(pp.bullet.type, counters[lvl]);
      } else {
        glyph = pp.buFont?.startsWith('Wingdings') ? WINGDINGS[pp.bullet.char] ?? '•' : pp.bullet.char;
      }
      const bu = h('span', { className: 'sl-bullet', textContent: glyph });
      bu.style.minWidth = `${Math.max(0, -(pp.indent ?? 0)) / EMU}px`;
      bu.style.color = pp.buColor ?? firstRP.color ?? '#000';
      para.append(bu);
    } else if (!hasText) counters.length = lvl;

    for (const r of runs) {
      if (r.localName === 'br') { para.append(h('br')); continue; }
      const rPr = at(r, 'rPr');
      const rp: RP = { ...rpBase };
      readRP(rPr, ctx, rp);
      const span = h('span', { textContent: at(r, 't')?.textContent ?? '' });
      const s = span.style;
      s.fontSize = `${(rp.sz ?? 18) * o.fontScale * (rp.baseline ? 0.7 : 1)}pt`;
      s.fontWeight = rp.b ? 'bold' : 'normal';
      s.fontStyle = rp.i ? 'italic' : 'normal';
      s.textDecoration = [rp.u ? 'underline' : '', rp.strike ? 'line-through' : ''].join(' ').trim() || 'none';
      s.color = rp.color ?? '#000';
      s.fontFamily = fontFamily(rp.font ?? '+mn-lt', ctx.slide.theme);
      if (rp.baseline) s.verticalAlign = rp.baseline > 0 ? 'super' : 'sub';
      const link = part.rels.get(rid(at(rPr, 'hlinkClick'), 'id'));
      if (link?.external && /^(https?|mailto):/i.test(link.target)) {
        const href = link.target;
        s.color = schemeColor(ctx, 'hlink') ?? s.color;
        s.textDecoration = 'underline';
        if (ctx.interactive) {
          span.className = 'sl-link';
          span.title = href;
          span.onclick = () => vscode.postMessage({ command: 'openExternal', href });
        }
      }
      para.append(span);
    }
    if (!runs.length) para.append('\u200b'); // empty paragraph keeps its line height
    target.append(para);
  }
}

/** Text frame: insets, vertical anchor and autofit merged over the inheritance chain */
function renderTextBody(txBody: El, part: Part, ctx: Ctx, chain: El[], o: Omit<TextOpts, 'fontScale' | 'lnReduce'>): HTMLElement {
  const bodyPrs = [...chain.map((s) => at(s, 'txBody', 'bodyPr')), at(txBody, 'bodyPr')].filter((b): b is El => !!b);
  const attr = (name: string) => bodyPrs.reduce<string | null>((v, b) => b.getAttribute(name) ?? v, null);
  const ins = (name: string, def: number) => `${num(attr(name), def) / EMU}px`;
  const fit = bodyPrs.map((b) => at(b, 'normAutofit')).filter(Boolean).pop() ?? null;
  const box = h('div', { className: 'sl-text' });
  Object.assign(box.style, {
    paddingLeft: ins('lIns', 91440), paddingRight: ins('rIns', 91440),
    paddingTop: ins('tIns', 45720), paddingBottom: ins('bIns', 45720),
    justifyContent: ({ ctr: 'center', b: 'flex-end' } as Record<string, string>)[attr('anchor') ?? ''] ?? 'flex-start',
    whiteSpace: attr('wrap') === 'none' ? 'pre' : 'pre-wrap',
  });
  renderParagraphs(box, txBody, part, ctx, {
    ...o,
    fontScale: num(fit?.getAttribute('fontScale'), 100000) / 100000,
    lnReduce: num(fit?.getAttribute('lnSpcReduction'), 0) / 100000,
  });
  return box;
}

// ── Shapes ────────────────────────────────────────────────────────────

function renderShape(sp: El, part: Part, ctx: Ctx, map: MapRect, isSlide: boolean): HTMLElement | null {
  const ph = phOf(sp);
  const { slide } = ctx;
  // Placeholders inherit position, text styles and frame settings from layout, then master
  const chain = ph && isSlide ? [findPh(slide.master, ph), findPh(slide.layout, ph)].filter((s): s is El => !!s) : [];
  const spPr = at(sp, 'spPr');
  const xf = readXfrm(at(spPr, 'xfrm')) ?? chain.map((s) => readXfrm(at(s, 'spPr', 'xfrm'))).filter(Boolean).pop();
  if (!xf) return null;
  const geom = at(spPr, 'prstGeom')?.getAttribute('prst') ?? 'rect';
  const ln = at(spPr, 'ln');
  const lineColor = at(ln, 'noFill') ? undefined : color(at(ln, 'solidFill'), ctx) ?? styleRef(sp, 'lnRef', ctx);
  const lineW = Math.max(0.75, num(ln?.getAttribute('w'), 12700) / EMU);
  const dashed = (at(ln, 'prstDash')?.getAttribute('val') ?? 'solid') !== 'solid';
  if (geom === 'line' || geom.startsWith('straightConnector')) return line(xf, map, lineColor, lineW, dashed);

  const txBody = at(sp, 'txBody');
  const el = place(h('div', { className: 'sl-shape' }), xf, map, !txBody);
  let bg = fill(spPr, ctx);
  for (const s of chain) if (bg === undefined) bg = fill(at(s, 'spPr'), ctx);
  if (bg === undefined) bg = styleRef(sp, 'fillRef', ctx);
  if (bg) el.style.background = bg;
  if (lineColor) el.style.border = `${lineW}px ${dashed ? 'dashed' : 'solid'} ${lineColor}`;
  if (geom === 'ellipse') el.style.borderRadius = '50%';
  else if (geom === 'roundRect') el.style.borderRadius = `${Math.min(xf.w, xf.h) / EMU / 6}px`;

  if (txBody) {
    const tx = at(slide.master?.root, 'txStyles');
    const kind = ph?.type;
    const masterStyle = !ph || !isSlide ? null
      : kid(tx, kind === 'title' ? 'titleStyle' : kind === 'body' ? 'bodyStyle' : 'otherStyle');
    const fontColor = styleRef(sp, 'fontRef', ctx);
    el.append(renderTextBody(txBody, part, ctx, chain, {
      styles: [masterStyle, ...chain.map((s) => at(s, 'txBody', 'lstStyle'))],
      base: fontColor ? { color: fontColor } : undefined,
    }));
  }
  return el;
}

function line(xf: Xfrm, map: MapRect, stroke = '#000', width: number, dashed: boolean): HTMLElement {
  const el = place(h('div', { className: 'sl-shape' }), xf, map, false);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'sl-line');
  const ln = document.createElementNS(ns, 'line');
  const r = map(xf);
  const [w, hh] = [r.w / EMU, r.h / EMU];
  const [x1, x2] = xf.flipH ? [w, 0] : [0, w];
  const [y1, y2] = xf.flipV ? [hh, 0] : [0, hh];
  for (const [k, v] of Object.entries({ x1, y1, x2, y2, stroke, 'stroke-width': width })) ln.setAttribute(k, String(v));
  if (dashed) ln.setAttribute('stroke-dasharray', `${width * 3} ${width * 2}`);
  svg.append(ln);
  el.append(svg);
  return el;
}

function renderPic(pic: El, part: Part, ctx: Ctx, map: MapRect): HTMLElement | null {
  const xf = readXfrm(at(pic, 'spPr', 'xfrm'));
  if (!xf) return null;
  const nvPr = at(pic, 'nvPicPr', 'nvPr');
  if (at(nvPr, 'videoFile') || desc(nvPr ?? pic, 'media').length) return unsupported('Video not shown', xf, map);
  if (at(nvPr, 'audioFile')) return unsupported('Audio not shown', xf, map);
  const el = place(h('div', { className: 'sl-shape' }), xf, map);
  const img = h('img', { className: 'sl-img', alt: '', decoding: 'async' });
  if (loadImage(ctx, part, rid(at(pic, 'blipFill', 'blip'), 'embed'), (url) => { img.src = url; })) el.append(img);
  else if (!ctx.images) el.classList.add('sl-imgph');
  else return unsupported('Image not shown', xf, map);
  return el;
}

function renderTable(tbl: El, part: Part, ctx: Ctx, xf: Xfrm, map: MapRect): HTMLElement {
  const el = place(h('div', { className: 'sl-shape' }), xf, map);
  const table = h('table', { className: 'sl-table' });
  const cols = kids(at(tbl, 'tblGrid'), 'gridCol').map((c) => num(c.getAttribute('w'), 0) / EMU);
  table.style.width = `${cols.reduce((a, b) => a + b, 0)}px`;
  table.append(h('colgroup', {}, ...cols.map((w) => { const c = h('col'); c.style.width = `${w}px`; return c; })));
  const tblPr = at(tbl, 'tblPr');
  // ponytail: any table style renders as "Medium Style 2" (accent1 header, banded rows); parse tableStyles.xml if decks need more
  const styled = !!at(tblPr, 'tableStyleId');
  const firstRow = tblPr?.getAttribute('firstRow') === '1', band = tblPr?.getAttribute('bandRow') === '1';
  const accent = (mods: string) => schemeColor(ctx, 'accent1', mods);
  kids(tbl, 'tr').forEach((tr, ri) => {
    const row = h('tr');
    row.style.height = `${num(tr.getAttribute('h'), 0) / EMU}px`;
    const header = styled && firstRow && ri === 0;
    for (const tc of kids(tr, 'tc')) {
      if (tc.getAttribute('hMerge') === '1' || tc.getAttribute('vMerge') === '1') continue;
      const td = h('td', {
        colSpan: Math.max(1, num(tc.getAttribute('gridSpan'), 1)),
        rowSpan: Math.max(1, num(tc.getAttribute('rowSpan'), 1)),
      });
      const tcPr = at(tc, 'tcPr');
      const bg = fill(tcPr, ctx) ?? (!styled ? undefined
        : header ? accent('') : band && (ri - (firstRow ? 1 : 0)) % 2 === 0 ? accent('<a:tint val="40000"/>') : accent('<a:tint val="20000"/>'));
      if (bg) td.style.background = bg;
      if (styled) td.style.borderColor = '#fff';
      td.style.verticalAlign = ({ ctr: 'middle', b: 'bottom' } as Record<string, string>)[tcPr?.getAttribute('anchor') ?? ''] ?? 'top';
      td.style.padding = ['marT', 'marR', 'marB', 'marL']
        .map((m, k) => `${num(tcPr?.getAttribute(m), k % 2 ? 91440 : 45720) / EMU}px`).join(' ');
      const tx = at(tc, 'txBody');
      if (tx) {
        renderParagraphs(td, tx, part, ctx, {
          styles: [], base: header ? { color: '#fff', b: true } : undefined, fontScale: 1, lnReduce: 0,
        });
      }
      row.append(td);
    }
    table.append(row);
  });
  el.append(table);
  return el;
}

function renderFrame(gf: El, part: Part, ctx: Ctx, map: MapRect): HTMLElement | null {
  const xf = readXfrm(at(gf, 'xfrm'));
  if (!xf) return null;
  const data = at(gf, 'graphic', 'graphicData');
  const tbl = at(data, 'tbl');
  if (tbl) return renderTable(tbl, part, ctx, xf, map);
  const uri = data?.getAttribute('uri') ?? '';
  const label = uri.includes('chart') ? 'Chart not shown' : uri.includes('diagram') ? 'SmartArt not shown'
    : uri.includes('ole') ? 'Embedded object not shown' : 'Content not shown';
  return unsupported(label, xf, map);
}

/** Render every shape in a shape tree, skipping (and logging) any that fail */
function renderTree(container: El | null, part: Part, ctx: Ctx, target: HTMLElement, map: MapRect, isSlide: boolean): void {
  for (const node of container?.children ?? []) {
    try {
      let el: HTMLElement | null = null;
      switch (node.localName) {
        case 'sp':
          // Layout and master placeholders are prompts ("Click to add title"), not content
          if (!isSlide && phOf(node)) continue;
          el = renderShape(node, part, ctx, map, isSlide);
          break;
        case 'cxnSp': {
          const xf = readXfrm(at(node, 'spPr', 'xfrm'));
          const ln = at(node, 'spPr', 'ln');
          if (xf) {
            el = line(xf, map, color(at(ln, 'solidFill'), ctx) ?? styleRef(node, 'lnRef', ctx),
              Math.max(0.75, num(ln?.getAttribute('w'), 12700) / EMU),
              (at(ln, 'prstDash')?.getAttribute('val') ?? 'solid') !== 'solid');
          }
          break;
        }
        case 'pic': el = renderPic(node, part, ctx, map); break;
        case 'graphicFrame': el = renderFrame(node, part, ctx, map); break;
        case 'grpSp': {
          // ponytail: group rotation and flips are ignored, only offset and scale apply
          const g = at(node, 'grpSpPr', 'xfrm');
          const off = at(g, 'off'), ext = at(g, 'ext'), chOff = at(g, 'chOff'), chExt = at(g, 'chExt');
          const n = (e: El | null, a: string) => num(e?.getAttribute(a), 0);
          const sx = n(chExt, 'cx') ? n(ext, 'cx') / n(chExt, 'cx') : 1;
          const sy = n(chExt, 'cy') ? n(ext, 'cy') / n(chExt, 'cy') : 1;
          const child: MapRect = (r) => map({
            x: n(off, 'x') + (r.x - n(chOff, 'x')) * sx, y: n(off, 'y') + (r.y - n(chOff, 'y')) * sy,
            w: r.w * sx, h: r.h * sy,
          });
          renderTree(node, part, ctx, target, child, isSlide);
          break;
        }
        case 'AlternateContent':
          renderTree(at(node, 'Fallback') ?? at(node, 'Choice'), part, ctx, target, map, isSlide);
          break;
      }
      if (el) target.append(el);
    } catch (e) {
      console.warn('Shape skipped', e);
    }
  }
}

function renderBackground(box: HTMLElement, ctx: Ctx): void {
  const { slide } = ctx;
  for (const part of [slide.part, slide.layout, slide.master]) {
    const bg = at(part?.root, 'cSld', 'bg');
    if (!part || !bg) continue;
    const bgPr = at(bg, 'bgPr');
    const blip = at(bgPr, 'blipFill', 'blip');
    if (blip) {
      loadImage(ctx, part, rid(blip, 'embed'), (url) => { box.style.backgroundImage = `url("${url}")`; });
      box.style.backgroundSize = '100% 100%';
      return;
    }
    const css = bgPr ? fill(bgPr, ctx) : color(at(bg, 'bgRef'), ctx);
    if (css) box.style.background = css;
    return;
  }
}

function renderSlide(ctx: Ctx): HTMLElement {
  const { slide, deck } = ctx;
  const box = h('div', { className: 'sl-slide' });
  box.style.width = `${deck.width}px`;
  box.style.height = `${deck.height}px`;
  box.style.fontFamily = fontFamily('+mn-lt', slide.theme);
  renderBackground(box, ctx);
  const tree = (p: Part | null) => at(p?.root, 'cSld', 'spTree');
  const id: MapRect = (r) => r;
  const showLayout = slide.part.root.getAttribute('showMasterSp') !== '0';
  const showMaster = showLayout && slide.layout?.root.getAttribute('showMasterSp') !== '0';
  if (showMaster && slide.master) renderTree(tree(slide.master), slide.master, ctx, box, id, false);
  if (showLayout && slide.layout) renderTree(tree(slide.layout), slide.layout, ctx, box, id, false);
  renderTree(tree(slide.part), slide.part, ctx, box, id, true);
  return box;
}

// ── UI ────────────────────────────────────────────────────────────────

interface View { slide: number; notes: boolean }
const state = getState<View>({ slide: 0, notes: false });

let deck: Deck | null = null;
let current: Ctx | null = null; // the main slide's render
let ui: { teardown(): void; show(i: number): void } | null = null;

function newCtx(slide: Slide, images: boolean): Ctx {
  return { deck: deck!, slide, images, interactive: images, urls: [], dead: false };
}

function dispose(ctx: Ctx | null): void {
  if (!ctx) return;
  ctx.dead = true;
  ctx.urls.forEach((u) => URL.revokeObjectURL(u));
  ctx.urls.length = 0;
}

function buildUi(info: FileInfo, d: Deck) {
  const n = d.slides.length;
  const counter = h('span', { className: 'dm-info' });
  const prev = h('button', { className: 'dm-btn', title: 'Previous slide (←)', onclick: () => show(state.slide - 1) }, '‹');
  const next = h('button', { className: 'dm-btn', title: 'Next slide (→)', onclick: () => show(state.slide + 1) }, '›');
  const notesBtn = h('button', { className: 'dm-btn', title: 'Speaker notes', onclick: () => toggleNotes() }, 'Notes');
  const listBtn = h('button', { className: 'dm-btn', title: 'Slide list', onclick: () => toggleList() }, 'Slides');
  const list = h('nav', { className: 'sl-list' });
  const fit = h('div', { className: 'sl-fit' });
  const stage = h('div', { className: 'dm-view sl-stage' }, fit);
  const notes = h('div', { className: 'sl-notes' });
  const main = h('div', { className: 'sl-main' }, list, h('div', { className: 'sl-center' }, stage, notes));
  app.replaceChildren(
    toolbar(listBtn, prev, counter, next, notesBtn, h('span', { className: 'dm-info' }, formatBytes(info.size))),
    main);

  const fitNow = () => {
    const el = fit.firstElementChild as HTMLElement | null;
    const k = Math.max(0.05, Math.min((stage.clientWidth - 32) / d.width, (stage.clientHeight - 32) / d.height));
    fit.style.width = `${d.width * k}px`;
    fit.style.height = `${d.height * k}px`;
    if (el?.classList.contains('sl-slide')) el.style.transform = `scale(${k})`;
  };
  const resize = new ResizeObserver(fitNow);
  resize.observe(stage);

  function toggleNotes() {
    state.notes = !state.notes;
    setState(state);
    notes.hidden = !state.notes;
    notesBtn.setAttribute('aria-pressed', String(state.notes));
  }
  state.notes = !state.notes;
  toggleNotes();

  function toggleList() {
    main.dataset.list = getComputedStyle(list).display === 'none' ? 'open' : 'closed';
  }

  // Thumbnails: rendered without images, only while visible in the list
  const thumbJobs = new Map<HTMLElement, object>();
  const thumbs = d.slides.map((_, i) => {
    const box = h('div', { className: 'sl-thumb-box' });
    box.style.aspectRatio = `${d.width} / ${d.height}`;
    box.dataset.i = String(i);
    const btn = h('button', { className: 'sl-thumb', title: `Slide ${i + 1}`, onclick: () => show(i) },
      h('span', { className: 'sl-num' }, String(i + 1)), box);
    list.append(btn);
    return btn;
  });
  const observer = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      const box = target as HTMLElement;
      const job = {};
      thumbJobs.set(box, job);
      if (!isIntersecting) { box.replaceChildren(); continue; }
      getSlide(d, Number(box.dataset.i)).then((slide) => {
        if (thumbJobs.get(box) !== job || deck !== d) return;
        const el = renderSlide(newCtx(slide, false));
        el.style.transform = `scale(${box.clientWidth / d.width})`;
        box.replaceChildren(el);
      }, () => box.replaceChildren(h('span', { className: 'sl-thumb-err' }, '!')));
    }
  }, { root: list, rootMargin: '100px' });
  thumbs.forEach((t) => observer.observe(t.lastElementChild!));

  async function show(i: number) {
    if (!n) return;
    i = Math.min(n - 1, Math.max(0, Math.floor(i) || 0));
    state.slide = i;
    setState(state);
    counter.textContent = `${i + 1} / ${n}`;
    prev.disabled = i === 0;
    next.disabled = i === n - 1;
    thumbs.forEach((t, k) => t.setAttribute('aria-current', String(k === i)));
    thumbs[i].scrollIntoView({ block: 'nearest' });
    dispose(current);
    current = null;
    try {
      const slide = await getSlide(d, i);
      if (state.slide !== i || deck !== d) return;
      const ctx = newCtx(slide, true);
      dispose(current);
      current = ctx;
      fit.replaceChildren(renderSlide(ctx));
      fitNow();
      notes.replaceChildren(
        h('div', { className: 'sl-notes-title' }, 'Notes'),
        ...(slide.notes.length ? slide.notes.map((t) => h('p', {}, t)) : [h('p', { className: 'sl-empty' }, 'No speaker notes')]));
    } catch (e) {
      if (state.slide === i) message(fit, `Could not show slide ${i + 1}: ${(e as Error).message}`, true);
    }
  }

  if (!n) message(fit, 'This presentation has no slides.');
  return {
    show,
    teardown() {
      observer.disconnect();
      resize.disconnect();
      thumbJobs.clear();
    },
  };
}

window.addEventListener('keydown', (e) => {
  if (!ui || e.altKey || e.ctrlKey || e.metaKey || (e.target as HTMLElement)?.closest?.('input, textarea')) return;
  const step: Record<string, number> = {
    ArrowLeft: -1, ArrowUp: -1, PageUp: -1, ArrowRight: 1, ArrowDown: 1, PageDown: 1,
    Home: -Infinity, End: Infinity,
  };
  if (!(e.key in step)) return;
  e.preventDefault();
  const s = step[e.key];
  ui.show(Number.isFinite(s) ? state.slide + s : s < 0 ? 0 : 1e9);
});

onFile(async (info) => {
  // Reload: drop every render, cache and blob URL of the previous version
  ui?.teardown();
  ui = null;
  dispose(current);
  current = null;
  deck = null;
  message(app, 'Loading presentation…');
  try {
    const zip = await JSZip.loadAsync(await fetchFile(info.src));
    const d = await openDeck(zip);
    if (app.dataset.src !== info.src) return; // a newer reload started meanwhile
    deck = d;
    ui = buildUi(info, d);
    await ui.show(state.slide);
  } catch (e) {
    app.replaceChildren(toolbar(), h('div', { className: 'dm-view' }));
    message(app.lastElementChild as HTMLElement, `Could not open this presentation: ${(e as Error).message}`, true);
  }
});
