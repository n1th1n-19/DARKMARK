// Shared helpers for every viewer bundle. Imported, never built as its own entry.

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

export const vscode = acquireVsCodeApi();

/** Data the extension put on #app: the file's webview URL and metadata */
export interface FileInfo {
  /** Webview URL of the file, with a ?v=<mtime> cache-buster */
  src: string;
  /** Webview URL of the extension root, no trailing slash (for out/pdfjs/...) */
  ext: string;
  name: string;
  size: number;
}

export const app = document.getElementById('app') as HTMLElement;

export function fileInfo(): FileInfo {
  const d = app.dataset;
  return { src: d.src!, ext: d.ext!, name: d.name!, size: Number(d.size) };
}

/** Fetch the file. Never send bytes through postMessage: fetch streams from disk. */
export async function fetchFile(src = fileInfo().src): Promise<ArrayBuffer> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
  return res.arrayBuffer();
}

/** Per-tab view state (page, zoom, scroll, ...), restored when a hidden tab comes back */
export function getState<T extends object>(defaults: T): T {
  return { ...defaults, ...((vscode.getState() as Partial<T>) ?? {}) };
}

export function setState<T extends object>(state: T): void {
  vscode.setState(state);
}

/** Build an element: h('button', { className: 'dm-btn', onclick }, 'Text') */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...children);
  return el;
}

/** Toolbar row with the viewer's controls and an "Open with default editor" button */
export function toolbar(...controls: (Node | string)[]): HTMLElement {
  return h(
    'div',
    { className: 'dm-toolbar' },
    ...controls,
    h('span', { className: 'dm-spacer' }),
    h('button', {
      className: 'dm-btn',
      title: 'Open with default editor',
      onclick: () => vscode.postMessage({ command: 'openDefault' }),
    }, 'Open with default editor')
  );
}

/** Replace the viewer area with a message (loading, error, empty) */
export function message(target: HTMLElement, text: string, error = false): void {
  target.replaceChildren(h('div', { className: 'dm-message' + (error ? ' dm-error' : '') }, text));
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/**
 * Run `load` now and again whenever the file changes on disk.
 * The extension posts { command: 'reload', src } with a new cache-buster.
 */
export function onFile(load: (info: FileInfo) => void | Promise<void>): void {
  const run = async (info: FileInfo) => {
    try {
      await load(info);
    } catch (e) {
      console.error(e);
    }
  };
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg?.command === 'reload' && typeof msg.src === 'string') {
      app.dataset.src = msg.src;
      app.dataset.size = String(msg.size);
      run(fileInfo());
    }
  });
  run(fileInfo());
}
