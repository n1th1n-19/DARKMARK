import mammoth from 'mammoth';
import { app, fetchFile, formatBytes, getState, h, message, onFile, setState, toolbar, vscode } from './common';
import './docx.css';

// docx content is untrusted: only these tags and attributes survive (see sanitize)
const TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'EM', 'U', 'S', 'SUB', 'SUP', 'A',
  'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR', 'IMG',
  'BLOCKQUOTE', 'PRE', 'CODE', 'SPAN',
]);
// Bookmark/footnote ids are kept with this prefix so they cannot clash with (or clobber) the viewer's own ids
const ID_PREFIX = 'dm-doc-';

const state = getState({ scrollTop: 0 });
const info = h('span', { className: 'dm-info' });
const warnings = h('span', { className: 'dm-info dm-warnings' });
const view = h('div', { className: 'dm-view' });
const page = h('article', { className: 'dm-docx-page' });
app.replaceChildren(toolbar(info, warnings), view);

let blobUrls: string[] = [];
let generation = 0;

function sanitize(html: string): DocumentFragment {
  // DOMParser documents are inert: nothing loads or runs while we clean it
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  for (const el of Array.from(body.querySelectorAll('*'))) {
    if (!TAGS.has(el.tagName)) { el.remove(); continue; }
    for (const { name, value } of Array.from(el.attributes)) {
      const keep =
        (name === 'href' && el.tagName === 'A') ||
        (name === 'alt' && el.tagName === 'IMG') ||
        (name === 'src' && el.tagName === 'IMG' && value.startsWith('blob:')) ||
        ((name === 'colspan' || name === 'rowspan') && (el.tagName === 'TD' || el.tagName === 'TH')) ||
        name === 'id';
      if (!keep) el.removeAttribute(name);
      else if (name === 'id') el.id = ID_PREFIX + value;
    }
    if (el.tagName === 'IMG' && !el.hasAttribute('src')) el.remove();
  }
  const frag = document.createDocumentFragment();
  frag.append(...Array.from(body.childNodes));
  return frag;
}

onFile(async ({ size }) => {
  const gen = ++generation;
  const keepScroll = page.isConnected ? view.scrollTop : state.scrollTop;
  info.textContent = formatBytes(size);
  warnings.textContent = '';
  if (!page.isConnected) message(view, 'Loading…');

  const urls: string[] = [];
  try {
    const arrayBuffer = await fetchFile();
    const result = await mammoth.convertToHtml({ arrayBuffer }, {
      styleMap: ['u => u'],
      convertImage: mammoth.images.imgElement(async (image) => {
        const url = URL.createObjectURL(new Blob([await image.readAsArrayBuffer()], { type: image.contentType }));
        urls.push(url);
        return { src: url };
      }),
    });
    if (gen !== generation) { urls.forEach(URL.revokeObjectURL); return; }

    const frag = sanitize(result.value);
    blobUrls.forEach(URL.revokeObjectURL);
    blobUrls = urls;
    page.replaceChildren(frag);
    if (!page.isConnected) view.replaceChildren(page);
    if (!page.hasChildNodes()) page.append(h('p', { className: 'dm-docx-empty' }, 'This document is empty.'));
    view.scrollTop = keepScroll;
    // Images have no size until they load; restore the scroll again once they have
    const imgs = Array.from(page.querySelectorAll('img')).filter((i) => !i.complete);
    if (imgs.length && view.scrollTop !== keepScroll) {
      const early = view.scrollTop;
      Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))).then(() => {
        if (gen === generation && view.scrollTop === early) view.scrollTop = keepScroll;
      });
    }

    const n = result.messages.length;
    if (n) {
      warnings.textContent = `${n} conversion warning${n === 1 ? '' : 's'}`;
      warnings.title = result.messages.map((m) => m.message).join('\n');
    }
  } catch (e) {
    urls.forEach(URL.revokeObjectURL);
    if (gen !== generation) return;
    blobUrls.forEach(URL.revokeObjectURL);
    blobUrls = [];
    page.replaceChildren();
    const why = e instanceof Error ? e.message : String(e);
    message(view, `Could not open this Word document: ${/central directory|zip/i.test(why) ? 'it is not a valid .docx file.' : why}`, true);
  }
});

page.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') ?? '';
  if (href.startsWith('#')) {
    document.getElementById(ID_PREFIX + decodeURIComponent(href.slice(1)))?.scrollIntoView();
  } else if (/^(https?:|mailto:)/i.test(href)) {
    vscode.postMessage({ command: 'openExternal', href });
  }
});

let pending = false;
view.addEventListener('scroll', () => {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    state.scrollTop = view.scrollTop;
    setState(state);
  });
});
