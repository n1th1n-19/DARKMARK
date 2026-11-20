// darkmark Git panel. Talks to src/git/index.ts through typed requests (src/git/protocol.ts).
// Rows are virtualized: the graph SVG exists only for visible rows, and at most MAX_COMMITS
// commits are kept; pages scrolled far away are dropped and fetched again on the way back.
import type { GraphRow } from '../git/graph';
import type { Commit } from '../git/log';
import type { FileDiff, Hunk } from '../git/diff';
import type { FileStatus } from '../git/status';
import type {
  Api, BlameLine, DiffResult, Event, Method, Overview, RebaseAction, Ref, Response, SearchKind,
} from '../git/protocol';
import { app, getState, h, message, setState, vscode } from './common';
import './git.css';

const PAGE = 300;
const MAX_COMMITS = 5000;
const ROW_H = 24;
const LANE_W = 14;
const MAX_LANES = 24;

type ViewName = 'graph' | 'changes' | 'history' | 'blame';
interface UiState {
  view: ViewName;
  path?: string;
  search: { kind: SearchKind; q: string };
  selected?: string;
  top: number;
}
const state = getState<UiState>({ view: 'graph', search: { kind: 'message', q: '' }, top: 0 });
const save = () => setState(state);

// ── Requests ──────────────────────────────────────────────────────────

let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function call<M extends Method>(method: M, params: Api[M][0]): Promise<Api[M][1]> {
  const id = ++seq;
  vscode.postMessage({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
}

/** Run an action: show progress, report errors, refresh afterwards */
async function act<M extends Method>(label: string, method: M, params: Api[M][0]): Promise<boolean> {
  busy.textContent = `${label}…`;
  try {
    await call(method, params);
    return true;
  } catch (e) {
    showError(`${label} failed: ${(e as Error).message}`);
    return false;
  } finally {
    busy.textContent = '';
    await refresh();
  }
}

window.addEventListener('message', (e) => {
  const m = e.data as Response | Event;
  if ('id' in m) {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error !== undefined) p.reject(new Error(m.error));
    else p.resolve(m.result);
  } else if (m.event === 'refresh') {
    refresh();
  } else if (m.event === 'show') {
    if (m.path) state.path = m.path;
    setView(m.view);
  }
});

// ── Chrome ────────────────────────────────────────────────────────────

const btn = (text: string, title: string, onclick: (e: MouseEvent) => void, cls = '') =>
  h('button', { className: `dm-btn ${cls}`.trim(), title, onclick }, text);

const tabs: Record<ViewName, HTMLButtonElement> = {
  graph: btn('Graph', 'Commit graph of all branches', () => setView('graph')),
  changes: btn('Changes', 'Working tree, commit and stashes', () => setView('changes')),
  history: btn('File History', 'History of one file', () => setView('history')),
  blame: btn('Blame', 'Who changed each line', () => setView('blame')),
};
const branchBtn = btn('', 'Switch branch', (e) => branchMenu(e));
const syncInfo = h('span', { className: 'dm-info' });
const busy = h('span', { className: 'dm-info g-busy' });
const toolbar = h('div', { className: 'dm-toolbar' },
  tabs.graph, tabs.changes, tabs.history, tabs.blame,
  h('span', { className: 'g-sep' }),
  branchBtn, syncInfo,
  btn('Fetch', 'git fetch --all --prune', () => act('Fetch', 'fetch', {})),
  btn('Pull', 'git pull', () => act('Pull', 'pull', {})),
  btn('Push', 'git push (sets upstream on first push)', () => act('Push', 'push', { force: false })),
  btn('▾', 'More push options', (e) => menu(e, [
    { label: 'Force push (--force-with-lease)', danger: true, run: async () => {
      if (await confirmBox('Force push?', 'Overwrites the remote branch with your local one, unless someone else pushed to it since your last fetch (--force-with-lease).', 'Force push', true)) {
        act('Force push', 'push', { force: true });
      }
    } },
  ])),
  busy,
  h('span', { className: 'dm-spacer' }),
  btn('Refresh', 'Reload from git', () => refresh()),
);
const banner = h('div', { className: 'g-banner', hidden: true });
const errorBar = h('div', { className: 'g-error', hidden: true });
const body = h('div', { className: 'g-body' });
app.replaceChildren(toolbar, banner, errorBar, body);

function showError(text: string) {
  errorBar.replaceChildren(h('span', {}, text), btn('Dismiss', 'Hide this message', () => { errorBar.hidden = true; }));
  errorBar.hidden = false;
}

// ── Overlays: menu, confirm, form ─────────────────────────────────────

interface MenuItem { label: string; run: () => void; danger?: boolean; disabled?: boolean }

function closeOverlays() { document.querySelectorAll('.g-menu, .g-modal-back').forEach((e) => e.remove()); }
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlays(); });
window.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('.g-menu, .g-modal')) document.querySelectorAll('.g-menu').forEach((m) => m.remove());
});

function menu(e: MouseEvent, items: (MenuItem | '-')[]) {
  e.preventDefault();
  e.stopPropagation();
  closeOverlays();
  const m = h('div', { className: 'g-menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { m.append(h('div', { className: 'g-menu-sep' })); continue; }
    m.append(h('button', {
      className: `g-menu-item${it.danger ? ' g-danger' : ''}`, disabled: !!it.disabled, role: 'menuitem',
      onclick: () => { m.remove(); it.run(); },
    }, it.label));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 4)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 4)}px`;
  (m.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
}

function modal(title: string, content: Node[], buttons: HTMLElement[]): HTMLElement {
  closeOverlays();
  const box = h('div', { className: 'g-modal', role: 'dialog' }, h('h3', {}, title), ...content, h('div', { className: 'g-modal-btns' }, ...buttons));
  const back = h('div', { className: 'g-modal-back' }, box);
  document.body.append(back);
  return box;
}

function confirmBox(title: string, text: string, ok: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => { back.remove(); resolve(v); };
    const okBtn = btn(ok, ok, () => done(true), danger ? 'g-danger' : 'g-primary');
    modal(title, [h('p', {}, text)], [btn('Cancel', 'Cancel', () => done(false)), okBtn]);
    const back = okBtn.closest('.g-modal-back') as HTMLElement;
    okBtn.focus();
  });
}

interface Field { key: string; label: string; value?: string | boolean; kind?: 'text' | 'textarea' | 'check' }
function form(title: string, fields: Field[], ok: string): Promise<Record<string, string | boolean> | null> {
  return new Promise((resolve) => {
    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    const rows = fields.map((f) => {
      const el = f.kind === 'textarea'
        ? h('textarea', { className: 'g-field', value: String(f.value ?? ''), rows: 4 })
        : h('input', f.kind === 'check'
          ? { type: 'checkbox', checked: !!f.value }
          : { className: 'g-field', type: 'text', value: String(f.value ?? '') });
      inputs.set(f.key, el);
      return h('label', { className: f.kind === 'check' ? 'g-check' : 'g-label' }, ...(f.kind === 'check' ? [el, f.label] : [f.label, el]));
    });
    const done = (v: Record<string, string | boolean> | null) => { back.remove(); resolve(v); };
    const submit = () => {
      const out: Record<string, string | boolean> = {};
      for (const [k, el] of inputs) out[k] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
      done(out);
    };
    const box = modal(title, rows, [btn('Cancel', 'Cancel', () => done(null)), btn(ok, ok, submit, 'g-primary')]);
    const back = box.parentElement as HTMLElement;
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!(e.target instanceof HTMLTextAreaElement) || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    });
    (box.querySelector('.g-field') as HTMLElement | null)?.focus();
  });
}

// ── Overview: branch, sync, in-progress operation ─────────────────────

let overview: Overview | null = null;

async function loadOverview() {
  overview = await call('overview', {});
  const s = overview.status;
  branchBtn.textContent = s.branch ?? `(detached ${s.oid?.slice(0, 7) ?? ''})`;
  syncInfo.textContent = s.upstream ? `↑${s.ahead} ↓${s.behind}` : s.branch ? 'no upstream' : '';
  const changed = s.files.length;
  tabs.changes.textContent = changed ? `Changes (${changed})` : 'Changes';
  renderBanner();
}

function renderBanner() {
  const op = overview?.op;
  if (!op) { banner.hidden = true; return; }
  const conflicts = overview!.status.files.filter((f) => f.conflict);
  banner.replaceChildren(
    h('strong', {}, `${op[0].toUpperCase()}${op.slice(1)} in progress`),
    h('span', {}, conflicts.length ? ` — ${conflicts.length} conflicted file${conflicts.length > 1 ? 's' : ''}: ` : ' — no conflicts left. '),
    ...conflicts.map((f) => h('button', {
      className: 'g-link', title: 'Open in the merge editor', onclick: () => call('openFile', { path: f.path, conflict: true }),
    }, f.path)),
    h('span', { className: 'dm-spacer' }),
    btn('Continue', conflicts.length ? 'Resolve and stage the conflicted files first' : `git ${op} --continue`,
      () => act('Continue', 'continueOp', {}), 'g-primary'),
    btn('Abort', `git ${op} --abort`, async () => {
      if (await confirmBox(`Abort the ${op}?`, 'Returns the branch to where it was before the operation started.', 'Abort', true)) act('Abort', 'abortOp', {});
    }, 'g-danger'),
  );
  banner.hidden = false;
}

function branchMenu(e: MouseEvent) {
  const heads = overview?.refs.filter((r) => r.kind === 'head') ?? [];
  menu(e, [
    { label: 'New branch…', run: () => newBranch('HEAD') },
    '-',
    ...heads.map((r) => ({ label: `${r.current ? '● ' : ''}${r.name}`, disabled: r.current, run: () => act('Checkout', 'checkout', { ref: r.name }) })),
  ]);
}

async function newBranch(at: string) {
  const v = await form('New branch', [
    { key: 'name', label: 'Name' },
    { key: 'checkout', label: 'Check it out', value: true, kind: 'check' },
  ], 'Create');
  if (v?.name) act('Create branch', 'branchCreate', { name: String(v.name).trim(), at, checkout: !!v.checkout });
}

// ── Views ─────────────────────────────────────────────────────────────

let current: { refresh(): Promise<void>; dispose?(): void } | null = null;

function setView(view: ViewName) {
  if ((view === 'history' || view === 'blame') && !state.path) {
    showError('Open File History or Blame from a file: right-click it in the explorer or in its editor tab.');
    view = 'graph';
  }
  state.view = view;
  save();
  for (const [k, b] of Object.entries(tabs)) b.setAttribute('aria-pressed', String(k === view));
  tabs.history.hidden = tabs.blame.hidden = !state.path;
  current?.dispose?.();
  current = view === 'changes' ? changesView() : view === 'blame' ? blameView(state.path!) : logView(view === 'history' ? state.path : undefined);
  current.refresh();
}

let refreshing: Promise<void> | null = null;
function refresh(): Promise<void> {
  // Coalesce: a refresh asked for while one runs waits for it and then runs once more
  const run = async () => {
    try {
      await loadOverview();
      await current?.refresh();
    } catch (e) {
      showError((e as Error).message);
    }
  };
  refreshing = (refreshing ?? Promise.resolve()).then(run, run);
  return refreshing;
}

// ── Graph and history list ────────────────────────────────────────────

function lanesSvg(row: GraphRow, width: number, merge: boolean): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(ROW_H));
  svg.setAttribute('class', 'g-lanes');
  const x = (i: number) => Math.min(i, MAX_LANES - 1) * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  const line = (x1: number, y1: number, x2: number, y2: number, lane: number) => {
    const l = document.createElementNS(ns, 'path');
    // Straight when vertical, a short curve when it changes lane
    l.setAttribute('d', x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);
    l.setAttribute('class', `g-lane g-c${lane % 8}`);
    svg.append(l);
  };
  for (const i of row.through) line(x(i), 0, x(i), ROW_H, i);
  for (const i of row.into) line(x(i), 0, x(row.col), mid, i);
  for (const j of row.out) line(x(row.col), mid, x(j), ROW_H, j);
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', String(x(row.col)));
  dot.setAttribute('cy', String(mid));
  dot.setAttribute('r', merge ? '3' : '4');
  dot.setAttribute('class', `g-dot g-c${row.col % 8}${merge ? ' g-merge' : ''}`);
  svg.append(dot);
  return svg;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const when = (t: number) => (t ? dateFmt.format(new Date(t * 1000)) : '');

function refBadges(c: Commit): HTMLElement[] {
  return c.refs.map((r) => {
    const tag = r.startsWith('tag: ');
    const head = r.startsWith('HEAD');
    const name = r.replace(/^tag: /, '').replace(/^HEAD -> /, '');
    return h('span', { className: `g-ref${tag ? ' g-tag' : ''}${head ? ' g-head' : ''}`, title: r }, name);
  });
}

function logView(file?: string) {
  const search = h('div', { className: 'g-search' });
  const list = h('div', { className: 'dm-view g-list', tabIndex: 0 });
  const spacer = h('div', { className: 'g-spacer' });
  const rowsBox = h('div', { className: 'g-rows' });
  list.append(spacer, rowsBox);
  const detail = h('div', { className: 'g-detail', hidden: true });
  const split = h('div', { className: 'g-split' }, list, detail);

  if (file) {
    search.append(h('span', { className: 'g-title' }, `History of ${file}`),
      btn('Blame', 'Blame this file', () => setView('blame')),
      btn('Open file', 'Open this file', () => call('openFile', { path: file })));
  } else {
    const kind = h('select', { className: 'dm-btn', title: 'Search in' },
      ...(['message', 'author', 'hash', 'path'] as SearchKind[]).map((k) => h('option', { value: k, selected: state.search.kind === k }, k)));
    const q = h('input', { className: 'dm-input g-q', type: 'search', placeholder: 'Search commits (Enter)', value: state.search.q });
    const go = () => { state.search = { kind: kind.value as SearchKind, q: q.value.trim() }; save(); reload(); };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    q.addEventListener('search', () => { if (!q.value) go(); });
    search.append(kind, q, btn('Search', 'Search with git log', go));
  }
  body.replaceChildren(search, split);

  // Loaded window of the log: commits[0] is at position `offset` in the full log
  let commits: Commit[] = [];
  let rows: GraphRow[] | null = null;
  let offset = 0;
  let more = false;
  let loading = false;
  let gen = 0;
  let laneW = 0;

  const searchParam = () => (!file && state.search.q ? state.search : undefined);

  async function fetchPage(skip: number) {
    return call('log', { skip, search: searchParam(), path: file });
  }

  function measure() {
    const max = rows ? rows.reduce((m, r) => Math.max(m, r.col, ...r.out, ...r.through), 0) : -1;
    laneW = rows ? Math.min(max + 1, MAX_LANES) * LANE_W + 6 : 0;
  }

  async function reload(keepScroll = false) {
    const g = ++gen;
    const top = keepScroll ? list.scrollTop : 0;
    // Refetch from the first page so the graph lanes are laid out from the top again
    const want = keepScroll ? Math.min(MAX_COMMITS, Math.ceil((top + list.clientHeight) / ROW_H / PAGE) * PAGE) : PAGE;
    let got: Commit[] = [], gotRows: GraphRow[] = [], m = false, isGraph = true;
    try {
      do {
        const r = await fetchPage(got.length);
        if (g !== gen) return;
        got = got.concat(r.commits);
        if (r.rows) gotRows = gotRows.concat(r.rows); else isGraph = false;
        m = r.more;
      } while (m && got.length < want);
    } catch (e) {
      if (g === gen) message(rowsBox, (e as Error).message, true);
      return;
    }
    commits = got; rows = isGraph ? gotRows : null; offset = 0; more = m;
    measure();
    if (!commits.length) message(rowsBox, file ? 'No history for this file.' : state.search.q ? 'No commits match.' : 'No commits yet.');
    list.scrollTop = top;
    render();
    if (state.selected && !detail.hidden) return;
    if (state.selected) showDetail(state.selected);
  }

  async function loadMore(dir: 1 | -1) {
    if (loading) return;
    loading = true;
    const g = gen;
    try {
      if (dir > 0 && more) {
        const r = await fetchPage(offset + commits.length);
        if (g !== gen) return;
        commits = commits.concat(r.commits);
        if (rows && r.rows) rows = rows.concat(r.rows);
        more = r.more;
        if (commits.length > MAX_COMMITS) { // drop the oldest page from memory
          commits = commits.slice(PAGE);
          rows = rows && rows.slice(PAGE);
          offset += PAGE;
        }
      } else if (dir < 0 && offset > 0) {
        const r = await fetchPage(offset - PAGE);
        if (g !== gen) return;
        commits = r.commits.concat(commits);
        if (rows && r.rows) rows = r.rows.concat(rows);
        offset -= PAGE;
        if (commits.length > MAX_COMMITS) {
          commits = commits.slice(0, commits.length - PAGE);
          rows = rows && rows.slice(0, commits.length);
          more = true;
        }
      }
      measure();
    } catch (e) {
      showError((e as Error).message);
    } finally {
      loading = false;
    }
    render();
  }

  function render() {
    const total = offset + commits.length;
    spacer.style.height = `${total * ROW_H}px`;
    if (!commits.length) return;
    const top = list.scrollTop, height = list.clientHeight || 600;
    const first = Math.max(offset, Math.floor(top / ROW_H) - 10);
    const last = Math.min(total, Math.ceil((top + height) / ROW_H) + 10);
    const els: HTMLElement[] = [];
    for (let i = first; i < last; i++) {
      const c = commits[i - offset];
      const row = rows?.[i - offset];
      const el = h('div', {
        className: `g-row${c.hash === state.selected ? ' g-selected' : ''}`,
        onclick: () => showDetail(c.hash),
        oncontextmenu: (e: MouseEvent) => commitMenu(e, c),
      });
      el.style.top = `${i * ROW_H}px`;
      if (row) el.append(h('span', { className: 'g-graph' }, lanesSvg(row, laneW, c.parents.length > 1)));
      el.append(
        h('span', { className: 'g-subject' }, ...refBadges(c), h('span', { title: c.subject }, c.subject)),
        h('span', { className: 'g-author', title: c.email }, c.author),
        h('span', { className: 'g-date' }, when(c.time)),
        h('span', { className: 'g-hash' }, c.hash.slice(0, 7)),
      );
      els.push(el);
    }
    rowsBox.replaceChildren(...els);
    // Near either end of the loaded window: fetch the neighbouring page
    if (last >= total - 50 && more) loadMore(1);
    else if (first <= offset + 50 && offset > 0) loadMore(-1);
  }

  let frame = 0;
  list.addEventListener('scroll', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { render(); state.top = list.scrollTop; save(); });
  });
  const resize = new ResizeObserver(() => render());
  resize.observe(list);

  async function showDetail(hash: string) {
    state.selected = hash;
    save();
    rowsBox.querySelectorAll('.g-selected').forEach((e) => e.classList.remove('g-selected'));
    render();
    const c = commits.find((x) => x.hash === hash);
    detail.hidden = false;
    message(detail, 'Loading…');
    try {
      const { files, body: msg } = await call('commitFiles', { hash });
      if (state.selected !== hash) return;
      const meta = h('div', { className: 'g-meta' },
        h('div', { className: 'g-meta-top' },
          h('button', { className: 'g-link g-mono', title: 'Copy the full hash', onclick: () => call('copy', { text: hash }) }, hash.slice(0, 10)),
          c ? h('span', {}, ` ${c.author} <${c.email}> · ${when(c.time)}`) : '',
          h('span', { className: 'dm-spacer' }),
          btn('×', 'Close', () => { detail.hidden = true; state.selected = undefined; save(); render(); })),
        c && c.refs.length ? h('div', {}, ...refBadges(c)) : '',
        h('pre', { className: 'g-message' }, msg),
        c && c.parents.length ? h('div', { className: 'dm-info' }, `Parents: ${c.parents.map((p) => p.slice(0, 7)).join(', ')}`) : '');
      const list2 = h('div', { className: 'g-files' },
        ...files.map((f) => fileRow(
          f.orig ? `${f.orig} → ${f.path}` : f.path,
          f.binary ? 'bin' : `+${f.added} −${f.deleted}`,
          () => call('commitDiff', { hash, path: f.path, orig: f.orig }),
          [btn('Open diff', 'Open in the diff editor', () => call('openDiff', { hash, path: f.path, orig: f.orig }))],
          () => call('openDiff', { hash, path: f.path, orig: f.orig }),
        )));
      detail.replaceChildren(meta, h('div', { className: 'g-files-title' }, `${files.length} file${files.length === 1 ? '' : 's'} changed`), list2);
    } catch (e) {
      message(detail, (e as Error).message, true);
    }
  }

  return {
    refresh: () => reload(true),
    dispose: () => { resize.disconnect(); gen++; },
  };
}

// ── Commit and ref actions ────────────────────────────────────────────

function refsOf(c: Commit): Ref[] {
  return overview?.refs.filter((r) => r.hash === c.hash) ?? [];
}

function commitMenu(e: MouseEvent, c: Commit) {
  const short = c.hash.slice(0, 7);
  const cur = overview?.status.branch;
  const items: (MenuItem | '-')[] = [
    { label: `Checkout ${short} (detached)`, run: () => act('Checkout', 'checkout', { ref: c.hash }) },
    { label: 'Create branch here…', run: () => newBranch(c.hash) },
    { label: 'Create tag here…', run: async () => {
      const v = await form('New tag', [{ key: 'name', label: 'Name' }, { key: 'message', label: 'Message (makes an annotated tag)', kind: 'textarea' }], 'Create');
      if (v?.name) act('Create tag', 'tagCreate', { name: String(v.name).trim(), at: c.hash, message: String(v.message ?? '') });
    } },
    '-',
    { label: `Merge ${short} into ${cur ?? 'HEAD'}`, run: () => act('Merge', 'merge', { ref: c.hash }) },
    { label: `Rebase ${cur ?? 'HEAD'} onto ${short}`, run: () => act('Rebase', 'rebaseOnto', { ref: c.hash }) },
    { label: `Interactive rebase onto ${short}…`, run: () => interactiveRebase(c) },
    { label: 'Cherry-pick', run: () => act('Cherry-pick', 'cherryPick', { hash: c.hash }) },
    { label: 'Revert', run: () => act('Revert', 'revert', { hash: c.hash }) },
    '-',
    ...(['soft', 'mixed', 'hard'] as const).map((mode) => ({
      label: `Reset ${cur ?? 'HEAD'} here (${mode})`, danger: mode === 'hard',
      run: async () => {
        const text = mode === 'hard'
          ? `Moves ${cur ?? 'HEAD'} to ${short} and throws away all uncommitted changes. This can't be undone.`
          : mode === 'soft' ? `Moves ${cur ?? 'HEAD'} to ${short}; later commits' changes stay staged.`
          : `Moves ${cur ?? 'HEAD'} to ${short}; later commits' changes stay in the working tree, unstaged.`;
        if (await confirmBox(`Reset (${mode})?`, text, 'Reset', mode === 'hard')) act('Reset', 'reset', { hash: c.hash, mode });
      },
    })),
  ];
  for (const r of refsOf(c)) {
    items.push('-');
    if (r.kind === 'head') {
      items.push(
        { label: `Checkout ${r.name}`, disabled: r.current, run: () => act('Checkout', 'checkout', { ref: r.name }) },
        { label: `Merge ${r.name} into ${cur ?? 'HEAD'}`, disabled: r.current, run: () => act('Merge', 'merge', { ref: r.name }) },
        { label: `Rename ${r.name}…`, run: async () => {
          const v = await form(`Rename ${r.name}`, [{ key: 'to', label: 'New name', value: r.name }], 'Rename');
          if (v?.to && v.to !== r.name) act('Rename branch', 'branchRename', { from: r.name, to: String(v.to).trim() });
        } },
        { label: `Delete ${r.name}`, danger: true, disabled: r.current, run: async () => {
          const v = await form(`Delete branch ${r.name}?`, [{ key: 'force', label: 'Delete even if not merged (-D)', kind: 'check' }], 'Delete');
          if (v) act('Delete branch', 'branchDelete', { name: r.name, force: !!v.force, remote: false });
        } },
      );
    } else if (r.kind === 'remote') {
      items.push(
        { label: `Checkout ${r.name}`, run: () => act('Checkout', 'checkout', { ref: r.name }) },
        { label: `Merge ${r.name} into ${cur ?? 'HEAD'}`, run: () => act('Merge', 'merge', { ref: r.name }) },
        { label: `Delete remote branch ${r.name}`, danger: true, run: async () => {
          if (await confirmBox(`Delete ${r.name} on the remote?`, 'Runs git push --delete. Others lose this branch too.', 'Delete', true)) {
            act('Delete remote branch', 'branchDelete', { name: r.name, force: false, remote: true });
          }
        } },
      );
    } else {
      items.push({ label: `Delete tag ${r.name}`, danger: true, run: async () => {
        if (await confirmBox(`Delete tag ${r.name}?`, 'Deletes the local tag only.', 'Delete', true)) act('Delete tag', 'tagDelete', { name: r.name });
      } });
    }
  }
  items.push('-', { label: 'Copy hash', run: () => call('copy', { text: c.hash }) }, { label: 'Copy message', run: () => call('copy', { text: c.subject }) });
  menu(e, items);
}

async function interactiveRebase(base: Commit) {
  let todo: Commit[];
  try {
    todo = await call('rebaseTodo', { base: base.hash });
  } catch (e) {
    showError((e as Error).message);
    return;
  }
  if (!todo.length) { showError(`No commits after ${base.hash.slice(0, 7)} on the current branch to rebase.`); return; }
  const steps = todo.map((c) => ({ c, action: 'pick' as RebaseAction, message: c.subject }));
  const listEl = h('div', { className: 'g-rebase' });
  const err = h('div', { className: 'g-error-text' });
  let dragFrom = -1;

  const draw = () => {
    listEl.replaceChildren(...steps.map((s, i) => {
      const sel = h('select', { className: 'dm-btn', onchange: () => { s.action = sel.value as RebaseAction; draw(); } },
        ...(['pick', 'reword', 'squash', 'fixup', 'drop'] as RebaseAction[]).map((a) => h('option', { value: a, selected: a === s.action }, a)));
      const row = h('div', { className: `g-rebase-row g-act-${s.action}`, draggable: true },
        h('span', { className: 'g-handle', title: 'Drag to reorder' }, '⋮⋮'), sel,
        h('span', { className: 'g-hash' }, s.c.hash.slice(0, 7)), h('span', { className: 'g-subject' }, s.c.subject));
      row.addEventListener('dragstart', () => { dragFrom = i; });
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragFrom < 0 || dragFrom === i) return;
        const [m] = steps.splice(dragFrom, 1);
        steps.splice(i, 0, m);
        dragFrom = -1;
        draw();
      });
      const wrap = h('div', {}, row);
      if (s.action === 'reword' || s.action === 'squash') {
        const ta = h('textarea', { className: 'g-field', rows: 3, value: s.message, placeholder: s.action === 'squash' ? 'Message for the combined commit (empty keeps git\'s default)' : '' });
        ta.addEventListener('input', () => { s.message = ta.value; });
        wrap.append(ta);
      }
      return wrap;
    }));
  };
  draw();

  const start = btn('Start rebase', 'Run git rebase -i with this list', async () => {
    const first = steps.find((s) => s.action !== 'drop');
    if (first && (first.action === 'squash' || first.action === 'fixup')) {
      err.textContent = 'The first commit kept can’t be squash or fixup: there is nothing before it to fold into.';
      return;
    }
    if (steps.some((s) => s.action === 'reword' && !s.message.trim())) {
      err.textContent = 'A reworded commit needs a message.';
      return;
    }
    closeOverlays();
    act('Interactive rebase', 'rebaseInteractive', {
      base: base.hash,
      steps: steps.map((s) => ({ hash: s.c.hash, action: s.action, message: s.action === 'reword' || s.action === 'squash' ? s.message : undefined })),
    });
  }, 'g-primary');
  const box = modal(`Interactive rebase onto ${base.hash.slice(0, 7)}`, [
    h('p', { className: 'dm-info' }, 'Oldest first. Drag to reorder; squash and fixup fold a commit into the one above it.'),
    listEl, err,
  ], [btn('Cancel', 'Cancel', () => closeOverlays()), start]);
  box.classList.add('g-wide');
}

// ── Diffs (shared by commit detail and working tree) ──────────────────

interface HunkActions {
  label: string;
  run: (hunk: Hunk, lines: number[]) => void;
  danger?: boolean;
}

function fileRow(name: string, stat: string, loadDiff: () => Promise<DiffResult>, buttons: HTMLElement[],
  openDiff: () => void, hunkActions: HunkActions[] = [], cls = ''): HTMLElement {
  const diffBox = h('div', { className: 'g-diff', hidden: true });
  const toggle = h('button', { className: 'g-file-name', title: 'Show the diff' }, name);
  toggle.setAttribute('aria-expanded', 'false'); // an attribute, not a DOM property: h() can't set it
  const row = h('div', { className: `g-file ${cls}`.trim() },
    h('div', { className: 'g-file-head' }, toggle, h('span', { className: 'g-stat' }, stat), ...buttons), diffBox);
  toggle.onclick = async () => {
    const open = diffBox.hidden;
    diffBox.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open) { diffBox.replaceChildren(); return; } // free the diff's DOM when collapsed
    message(diffBox, 'Loading…');
    try {
      renderDiff(diffBox, await loadDiff(), openDiff, hunkActions);
    } catch (e) {
      message(diffBox, (e as Error).message, true);
    }
  };
  return row;
}

function renderDiff(box: HTMLElement, r: DiffResult, openDiff: () => void, actions: HunkActions[]) {
  if (r.kind === 'large' || r.kind === 'binary') {
    box.replaceChildren(h('div', { className: 'g-diff-note' },
      r.kind === 'large' ? 'Diff too large — ' : 'Binary file — ',
      h('button', { className: 'g-link', onclick: openDiff }, 'open in diff editor')));
    return;
  }
  const f: FileDiff | null = r.file;
  if (!f || !f.hunks.length) { box.replaceChildren(h('div', { className: 'g-diff-note' }, 'No textual changes (mode or rename only).')); return; }
  box.replaceChildren(...f.hunks.map((hunk) => {
    const sel = new Set<number>();
    const btns = actions.map((a) => {
      const b = btn('', a.label, () => a.run(hunk, [...sel]), a.danger ? 'g-danger g-small' : 'g-small');
      return [a, b] as const;
    });
    const label = () => btns.forEach(([a, b]) => {
      b.textContent = sel.size ? `${a.label} ${sel.size} line${sel.size > 1 ? 's' : ''}` : `${a.label} hunk`;
    });
    label();
    let oldN = hunk.oldStart, newN = hunk.newStart;
    const lines = hunk.lines.map((l, i) => {
      const t = l[0];
      const o = t === '+' || t === '\\' ? '' : String(oldN++);
      const n = t === '-' || t === '\\' ? '' : String(newN++);
      const el = h('div', { className: `g-line ${t === '+' ? 'g-add' : t === '-' ? 'g-del' : t === '\\' ? 'g-nonl' : ''}` },
        h('span', { className: 'g-ln' }, o), h('span', { className: 'g-ln' }, n), h('span', { className: 'g-code' }, l));
      if (actions.length && (t === '+' || t === '-')) {
        el.classList.add('g-pickable');
        el.title = 'Click to select this line';
        el.onclick = () => { sel.has(i) ? sel.delete(i) : sel.add(i); el.classList.toggle('g-picked'); label(); };
      }
      return el;
    });
    return h('div', { className: 'g-hunk' },
      h('div', { className: 'g-hunk-head' }, h('span', { className: 'g-mono' }, hunk.header), ...btns.map(([, b]) => b)),
      ...lines);
  }));
}

// ── Working tree ──────────────────────────────────────────────────────

function changesView() {
  const msg = h('textarea', { className: 'g-field g-commit-msg', rows: 3, placeholder: 'Commit message (Ctrl+Enter to commit)' });
  const amend = h('input', { type: 'checkbox' });
  const signoff = h('input', { type: 'checkbox' });
  const commitBtn = btn('Commit', 'Commit the staged changes', () => commit(), 'g-primary');
  const lists = h('div', { className: 'g-changes' });
  body.replaceChildren(h('div', { className: 'dm-view g-changes-view' },
    h('div', { className: 'g-commit' }, msg,
      h('div', { className: 'g-commit-row' },
        h('label', { className: 'g-check' }, amend, 'Amend last commit'),
        h('label', { className: 'g-check' }, signoff, 'Sign-off'),
        h('span', { className: 'dm-spacer' }), commitBtn)),
    lists));

  msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(); });
  amend.addEventListener('change', async () => {
    if (amend.checked && !msg.value.trim()) msg.value = await call('lastMessage', {}).catch(() => '');
  });

  async function commit() {
    if (await act('Commit', 'commit', { message: msg.value, amend: amend.checked, signoff: signoff.checked })) {
      msg.value = '';
      amend.checked = false;
    }
  }

  const section = (title: string, files: FileStatus[], head: HTMLElement[], row: (f: FileStatus) => HTMLElement) =>
    files.length ? h('section', {}, h('div', { className: 'g-section-head' }, h('span', {}, `${title} (${files.length})`), ...head), ...files.map(row)) : '';

  const letter = (f: FileStatus, staged: boolean) => (f.untracked ? 'U' : f.conflict ? '!' : staged ? f.x : f.y);

  function render() {
    const files = overview?.status.files ?? [];
    const conflicts = files.filter((f) => f.conflict);
    const staged = files.filter((f) => !f.conflict && !f.untracked && f.x !== '.');
    const unstaged = files.filter((f) => !f.conflict && (f.untracked || f.y !== '.'));
    const stashes = overview?.stashes ?? [];

    const discard = async (fs: FileStatus[]) => {
      const n = fs.length;
      if (!await confirmBox(`Discard ${n === 1 ? fs[0].path : `${n} files`}?`,
        'Your unstaged changes are lost, and untracked files are deleted. This can’t be undone.', 'Discard', true)) return;
      act('Discard', 'discard', { paths: fs.filter((f) => !f.untracked).map((f) => f.path), untracked: fs.filter((f) => f.untracked).map((f) => f.path) });
    };
    const lineAct = (f: FileStatus, staged: boolean, discardIt = false) => (hunk: Hunk, lines: number[]) =>
      act(discardIt ? 'Discard' : staged ? 'Unstage' : 'Stage', 'stageLines', { path: f.path, staged, discard: discardIt, hunk: hunk.header, lines });

    lists.replaceChildren(
      section('Merge conflicts', conflicts, [], (f) => fileRow(f.path, '!', () => call('workDiff', { path: f.path, staged: false, untracked: false }),
        [btn('Open', 'Resolve in the merge editor', () => call('openFile', { path: f.path, conflict: true })),
          btn('Mark resolved', 'Stage the file', () => act('Stage', 'stage', { paths: [f.path] }))],
        () => call('openFile', { path: f.path, conflict: true }), [], 'g-conflict')),
      section('Staged', staged, [btn('Unstage all', 'Unstage everything', () => act('Unstage', 'unstage', { paths: staged.map((f) => f.path) }), 'g-small')],
        (f) => fileRow(f.orig ? `${f.orig} → ${f.path}` : f.path, letter(f, true),
          () => call('workDiff', { path: f.path, staged: true, untracked: false }),
          [btn('Open diff', 'Open in the diff editor', () => call('openDiff', { path: f.path, staged: true })),
            btn('Unstage', 'Unstage this file', () => act('Unstage', 'unstage', { paths: [f.path] }))],
          () => call('openDiff', { path: f.path, staged: true }),
          f.x === 'M' ? [{ label: 'Unstage', run: lineAct(f, true) }] : [])),
      section('Changes', unstaged, [
        btn('Stage all', 'Stage everything', () => act('Stage', 'stage', { paths: unstaged.map((f) => f.path) }), 'g-small'),
        btn('Discard all', 'Discard every unstaged change', () => discard(unstaged), 'g-small g-danger')],
        (f) => fileRow(f.path, letter(f, false),
          () => call('workDiff', { path: f.path, staged: false, untracked: f.untracked }),
          [...(f.untracked ? [] : [btn('Open diff', 'Open in the diff editor', () => call('openDiff', { path: f.path }))]),
            btn('Open', 'Open the file', () => call('openFile', { path: f.path })),
            btn('Discard', 'Discard the changes', () => discard([f]), 'g-danger'),
            btn('Stage', 'Stage this file', () => act('Stage', 'stage', { paths: [f.path] }))],
          () => (f.untracked ? call('openFile', { path: f.path }) : call('openDiff', { path: f.path })),
          f.y === 'M' ? [{ label: 'Stage', run: lineAct(f, false) }, { label: 'Discard', danger: true, run: async (hk, ln) => {
            if (await confirmBox('Discard these lines?', 'They are removed from the working tree. This can’t be undone.', 'Discard', true)) lineAct(f, false, true)(hk, ln);
          } }] : [])),
      !conflicts.length && !staged.length && !unstaged.length ? h('div', { className: 'dm-message' }, 'No changes. The working tree is clean.') : '',
      h('section', {},
        h('div', { className: 'g-section-head' }, h('span', {}, `Stashes (${stashes.length})`),
          btn('Stash changes…', 'git stash push', async () => {
            const v = await form('Stash changes', [{ key: 'message', label: 'Message (optional)' }, { key: 'untracked', label: 'Include untracked files', kind: 'check' }], 'Stash');
            if (v) act('Stash', 'stashSave', { message: String(v.message ?? ''), untracked: !!v.untracked });
          }, 'g-small')),
        ...stashes.map((s) => h('div', { className: 'g-file-head g-stash' },
          h('span', { className: 'g-mono' }, `stash@{${s.index}}`), h('span', { className: 'g-subject' }, s.subject),
          btn('Apply', 'Apply and keep the stash', () => act('Apply stash', 'stashApply', { index: s.index, pop: false }), 'g-small'),
          btn('Pop', 'Apply and drop the stash', () => act('Pop stash', 'stashApply', { index: s.index, pop: true }), 'g-small'),
          btn('Drop', 'Delete the stash', async () => {
            if (await confirmBox(`Drop stash@{${s.index}}?`, 'The stashed changes are deleted.', 'Drop', true)) act('Drop stash', 'stashDrop', { index: s.index });
          }, 'g-small g-danger')))),
    );
  }

  return { refresh: async () => render() };
}

// ── Blame ─────────────────────────────────────────────────────────────

function blameView(file: string) {
  const list = h('div', { className: 'dm-view g-list g-blame' });
  const spacer = h('div', { className: 'g-spacer' });
  const rowsBox = h('div', { className: 'g-rows' });
  list.append(spacer, rowsBox);
  body.replaceChildren(h('div', { className: 'g-search' },
    h('span', { className: 'g-title' }, `Blame of ${file}`),
    btn('File history', 'History of this file', () => setView('history')),
    btn('Open file', 'Open this file', () => call('openFile', { path: file }))), list);
  let lines: BlameLine[] = [];
  const BH = 20;
  const render = () => {
    spacer.style.height = `${lines.length * BH}px`;
    const first = Math.max(0, Math.floor(list.scrollTop / BH) - 10);
    const last = Math.min(lines.length, Math.ceil((list.scrollTop + (list.clientHeight || 600)) / BH) + 10);
    const els: HTMLElement[] = [];
    for (let i = first; i < last; i++) {
      const l = lines[i];
      const start = i === 0 || lines[i - 1].hash !== l.hash;
      const uncommitted = /^0+$/.test(l.hash);
      const el = h('div', { className: `g-row g-blame-row${start ? ' g-blame-start' : ''}` },
        h('span', { className: 'g-blame-gutter', title: start ? `${l.summary}\n${l.author} · ${when(l.time)}` : '' },
          start ? (uncommitted ? 'Not committed yet' : `${l.hash.slice(0, 7)} ${l.author} · ${when(l.time)}`) : ''),
        h('span', { className: 'g-ln' }, String(i + 1)),
        h('span', { className: 'g-code' }, l.text));
      el.style.top = `${i * BH}px`;
      el.style.height = `${BH}px`;
      els.push(el);
    }
    rowsBox.replaceChildren(...els);
  };
  list.addEventListener('scroll', () => requestAnimationFrame(render));
  return {
    refresh: async () => {
      if (!lines.length) message(rowsBox, 'Loading…');
      try {
        lines = await call('blame', { path: file });
        render();
      } catch (e) {
        message(rowsBox, (e as Error).message, true);
      }
    },
  };
}

// ── Start ─────────────────────────────────────────────────────────────

loadOverview().catch((e) => showError((e as Error).message));
setView(state.view);
