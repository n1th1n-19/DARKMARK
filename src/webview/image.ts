import { app, fileInfo, formatBytes, getState, h, message, onFile, setState, toolbar } from './common';
import './image.css';

// The image is shown through <img> straight from the webview URL: never fetched into JS memory,
// never drawn to a canvas, and SVG scripts never run. Zoom and pan are a CSS transform.
type Mode = 'fit' | '1:1' | 'free';
const state = getState({ mode: 'fit' as Mode, zoom: 1, x: 0, y: 0 });
const MIN = 0.02, MAX = 64, STEP = 1.25;

const img = h('img', { className: 'dm-image', decoding: 'async', draggable: false, alt: '' });
const view = h('div', { className: 'dm-view dm-image-view' });
const btn = (text: string, title: string, onclick: () => void) => h('button', { className: 'dm-btn', title, onclick }, text);
const fitBtn = btn('Fit', 'Fit to window (0)', () => setMode('fit'));
const oneBtn = btn('1:1', 'Actual size (1)', () => setMode('1:1'));
const pct = h('span', { className: 'dm-info dm-image-pct' });
const info = h('span', { className: 'dm-info' });
app.replaceChildren(
  toolbar(fitBtn, oneBtn, btn('−', 'Zoom out (−)', () => zoomBy(1 / STEP)), btn('+', 'Zoom in (+)', () => zoomBy(STEP)), pct, info),
  view
);

let iw = 0, ih = 0; // displayed (unscaled) size of the image
let loaded = false;

function clampPan() {
  const vw = view.clientWidth, vh = view.clientHeight;
  const sw = iw * state.zoom, sh = ih * state.zoom;
  state.x = sw <= vw ? (vw - sw) / 2 : Math.min(0, Math.max(vw - sw, state.x));
  state.y = sh <= vh ? (vh - sh) / 2 : Math.min(0, Math.max(vh - sh, state.y));
}

let frame = 0;
function render() {
  if (!loaded) return;
  if (state.mode === 'fit') state.zoom = Math.min(1, view.clientWidth / iw, view.clientHeight / ih) || 1;
  if (state.mode === '1:1') state.zoom = 1;
  clampPan();
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    img.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
    img.classList.toggle('dm-pixelated', state.zoom >= 3);
    view.classList.toggle('dm-pannable', iw * state.zoom > view.clientWidth || ih * state.zoom > view.clientHeight);
    pct.textContent = `${Math.round(state.zoom * 100)}%`;
    fitBtn.setAttribute('aria-pressed', String(state.mode === 'fit'));
    oneBtn.setAttribute('aria-pressed', String(state.mode === '1:1'));
    setState(state);
  });
}

function setMode(mode: Mode) {
  state.mode = mode;
  if (mode === '1:1') { state.x = (view.clientWidth - iw) / 2; state.y = (view.clientHeight - ih) / 2; }
  render();
}

/** Zoom to `z`, keeping the view point (cx, cy) fixed on the same image pixel */
function zoomTo(z: number, cx = view.clientWidth / 2, cy = view.clientHeight / 2, mode: Mode = 'free') {
  z = Math.min(MAX, Math.max(MIN, z));
  state.x = cx - ((cx - state.x) * z) / state.zoom;
  state.y = cy - ((cy - state.y) * z) / state.zoom;
  state.zoom = z;
  state.mode = mode;
  render();
}
const zoomBy = (f: number) => zoomTo(state.zoom * f);

view.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = view.getBoundingClientRect();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // lines → pixels
  zoomTo(state.zoom * Math.exp(-dy * 0.002), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

view.addEventListener('dblclick', (e) => {
  const r = view.getBoundingClientRect();
  if (state.mode === 'fit') zoomTo(1, e.clientX - r.left, e.clientY - r.top, '1:1');
  else setMode('fit');
});

let drag: { id: number; x: number; y: number } | null = null;
view.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !view.classList.contains('dm-pannable')) return;
  drag = { id: e.pointerId, x: e.clientX - state.x, y: e.clientY - state.y };
  view.setPointerCapture(e.pointerId);
  view.classList.add('dm-dragging');
});
view.addEventListener('pointermove', (e) => {
  if (drag?.id !== e.pointerId) return;
  state.x = e.clientX - drag.x;
  state.y = e.clientY - drag.y;
  if (state.mode === 'fit') state.mode = 'free';
  render();
});
const endDrag = () => { drag = null; view.classList.remove('dm-dragging'); };
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '+' || e.key === '=') zoomBy(STEP);
  else if (e.key === '-' || e.key === '_') zoomBy(1 / STEP);
  else if (e.key === '0') setMode('fit');
  else if (e.key === '1') setMode('1:1');
  else return;
  e.preventDefault();
});

new ResizeObserver(render).observe(view);

img.addEventListener('load', () => {
  const svg = /\.svg$/i.test(fileInfo().name);
  // An SVG with only a viewBox has no intrinsic size: show it at the view's size
  const intrinsic = img.naturalWidth > 0 && img.naturalHeight > 0;
  iw = intrinsic ? img.naturalWidth : view.clientWidth || 300;
  ih = intrinsic ? img.naturalHeight : view.clientHeight || 150;
  img.style.width = `${iw}px`;
  img.style.height = `${ih}px`;
  info.textContent = [svg && !intrinsic ? 'SVG' : `${iw} × ${ih} px`, formatBytes(fileInfo().size)].join(' · ');
  if (!img.isConnected) view.replaceChildren(img);
  loaded = true;
  render();
});
img.addEventListener('error', () => {
  loaded = false;
  info.textContent = formatBytes(fileInfo().size);
  message(view, 'Could not decode this image.', true);
});

onFile(({ src }) => {
  // Keeps zoom and pan; only the cache-buster in src changes on reload
  img.src = src;
});
