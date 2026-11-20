// HTML from GitHub (PR and issue bodies, comments, reviews) is untrusted. The host renders the
// Markdown with raw HTML on (GitHub bodies use <details>, <img>, <sub>...); this rebuilds it from
// an allowlist. Parsed nodes are never inserted: every kept element is created fresh, with only
// the attributes listed here, so scripts, handlers, styles, forms and frames can't survive.

const TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'INS', 'SUB', 'SUP',
  'A', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'BR', 'HR', 'IMG',
  'BLOCKQUOTE', 'PRE', 'CODE', 'KBD', 'SAMP', 'SPAN', 'DIV', 'DETAILS', 'SUMMARY', 'INPUT', 'DL', 'DT', 'DD', 'MARK', 'SMALL',
]);
// Removed with everything inside. Unknown elements not listed here are unwrapped (text kept).
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'LINK', 'META',
  'BASE', 'FORM', 'NOSCRIPT', 'TEXTAREA', 'SELECT', 'BUTTON', 'AUDIO', 'VIDEO', 'SOURCE', 'TITLE', 'HEAD']);
const ATTRS: Record<string, string[]> = {
  A: ['href', 'title'], IMG: ['src', 'alt', 'width', 'height', 'title'], TD: ['colspan', 'rowspan', 'align'],
  TH: ['colspan', 'rowspan', 'align'], OL: ['start'], DETAILS: ['open'], INPUT: ['type', 'checked'], CODE: ['class'],
};
const SAFE_HREF = /^(https?:|mailto:|#)/i;
/** The only remote images the panel's CSP lets through */
export const AVATAR_HOST = 'https://avatars.githubusercontent.com/';

export function sanitize(html: string): DocumentFragment {
  const src = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  const out = document.createDocumentFragment();
  copyChildren(src, out);
  return out;
}

function copyChildren(from: Node, to: Node): void {
  for (const n of Array.from(from.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) { to.appendChild(document.createTextNode(n.textContent ?? '')); continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue; // comments, processing instructions
    const el = n as Element;
    const tag = el.tagName.toUpperCase();
    if (DROP.has(tag)) continue;
    if (!TAGS.has(tag)) { copyChildren(el, to); continue; } // unwrap: <picture>, <g-emoji>, custom tags
    if (tag === 'IMG') { to.appendChild(image(el)); continue; }
    if (tag === 'INPUT' && el.getAttribute('type') !== 'checkbox') continue; // task-list boxes only
    const clean = document.createElement(tag.toLowerCase());
    for (const name of ATTRS[tag] ?? []) {
      const v = el.getAttribute(name);
      if (v === null) continue;
      if (name === 'href' && !SAFE_HREF.test(v.trim())) continue;
      if (name === 'class' && !/^language-[\w+-]+$/.test(v)) continue;
      clean.setAttribute(name, v);
    }
    if (tag === 'INPUT') clean.setAttribute('disabled', '');
    copyChildren(el, clean);
    to.appendChild(clean);
  }
}

/** Avatars load; any other image becomes a link to it, since the CSP blocks other hosts */
function image(el: Element): Node {
  const src = (el.getAttribute('src') ?? '').trim();
  const alt = el.getAttribute('alt') ?? '';
  if (src.startsWith(AVATAR_HOST)) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    for (const a of ['width', 'height']) { const v = el.getAttribute(a); if (v && /^\d+$/.test(v)) img.setAttribute(a, v); }
    return img;
  }
  if (!/^https?:/i.test(src)) return document.createTextNode(alt);
  // Decorative icons (bots put 16px images in their reviews): drop rather than link
  if (!alt && Number(el.getAttribute('width')) > 0 && Number(el.getAttribute('width')) <= 24) return document.createTextNode('');
  const a = document.createElement('a');
  a.href = src;
  a.className = 'g-md-img';
  a.textContent = alt ? `Image: ${alt}` : 'Image';
  return a;
}
