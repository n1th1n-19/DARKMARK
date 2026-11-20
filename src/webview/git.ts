// darkmark Git panel. Talks to src/git/index.ts through typed requests (src/git/protocol.ts).
// Rows are virtualized: the graph SVG exists only for visible rows, and at most MAX_COMMITS
// commits are kept; pages scrolled far away are dropped and fetched again on the way back.
import type { GraphRow } from '../git/graph';
import type { Commit } from '../git/log';
import type { FileDiff, Hunk } from '../git/diff';
import type { FileStatus } from '../git/status';
import type { CheckRun } from '../github/rollup';
import type {
  Api, BlameLine, DiffResult, Event, GhCommit, Label, Method, Overview, PrDetail, PrItem, RebaseAction, Ref, Response, SearchKind, TimelineItem,
} from '../git/protocol';
import { app, getState, h, message, setState, vscode } from './common';
import { AVATAR_HOST, sanitize } from './lib/sanitize';
import './git.css';

const PAGE = 300;
const MAX_COMMITS = 5000;
const ROW_H = 24;
const LANE_W = 14;
const MAX_LANES = 24;

type ViewName = 'graph' | 'changes' | 'history' | 'blame' | 'github';
type GhSection = 'prs' | 'issues' | 'actions' | 'commits';
interface UiState {
  view: ViewName;
  path?: string;
  search: { kind: SearchKind; q: string };
  selected?: string;
  top: number;
  gh: {
    section: GhSection; listState: 'open' | 'closed'; prFilter: 'open' | 'mine' | 'review'; issueSearch: string;
    open?: number; tab?: 'conversation' | 'commits' | 'checks' | 'files'; run?: number; job?: number; allRuns: boolean;
  };
}
const state = getState<UiState>({
  view: 'graph', search: { kind: 'message', q: '' }, top: 0,
  gh: { section: 'prs', listState: 'open', prFilter: 'open', issueSearch: '', allRuns: false },
});
state.gh = { section: 'prs', listState: 'open', prFilter: 'open', issueSearch: '', allRuns: false, ...(state.gh as Partial<UiState['gh']>) };
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
  // Fetch, pull and push can change which commits are PR heads
  if (method === 'fetch' || method === 'pull' || method === 'push') prHeads = null;
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
  github: btn('GitHub', 'Pull requests, issues and Actions (through gh)', () => setView('github')),
};
const branchBtn = btn('', 'Switch branch', (e) => branchMenu(e));
const syncInfo = h('span', { className: 'dm-info' });
const busy = h('span', { className: 'dm-info g-busy' });
const toolbar = h('div', { className: 'dm-toolbar' },
  tabs.graph, tabs.changes, tabs.github, tabs.history, tabs.blame,
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
  current = view === 'github' ? githubView() : view === 'changes' ? changesView() : view === 'blame' ? blameView(state.path!) : logView(view === 'history' ? state.path : undefined);
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
  }).concat(prHeads?.[c.hash] ? [h('button', {
    className: 'g-ref g-pr', title: 'Open this pull request in the GitHub tab',
    onclick: (e: MouseEvent) => { e.stopPropagation(); Object.assign(state.gh, { section: 'prs', open: prHeads![c.hash], tab: undefined }); setView('github'); },
  }, `#${prHeads[c.hash]}`)] : []);
}

// PR head commits for the graph: fetched once per panel session, again after fetch, pull or push
let prHeads: Record<string, number> | null = null;
let prHeadsLoading = false;
async function loadPrHeads(after: () => void) {
  if (prHeads || prHeadsLoading) return;
  prHeadsLoading = true;
  try {
    const s = await call('ghState', {});
    prHeads = s.ok ? await call('prHeads', {}) : {};
    after();
  } catch {
    prHeads = {}; // no gh, no network or not a GitHub repo: the graph just has no PR numbers
  } finally {
    prHeadsLoading = false;
  }
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
    if (!file) loadPrHeads(render);
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

// ── GitHub (through gh), laid out like github.com ──────────────────────

/** Small 16px stroke icons, drawn here (no icon font, no emoji) */
const ICONS: Record<string, string> = {
  prOpen: '<circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><path d="M4 5.3v5.4"/><circle cx="12" cy="12.5" r="1.8"/><path d="M12 10.7V6.5a2 2 0 0 0-2-2H7.5"/><path d="M9 3l-1.5 1.5L9 6"/>',
  prMerged: '<circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><path d="M4 5.3v5.4"/><circle cx="12" cy="8.5" r="1.8"/><path d="M4 5.3c0 2.5 2.5 3.2 6.2 3.2"/>',
  prClosed: '<circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><path d="M4 5.3v5.4"/><circle cx="12" cy="12.5" r="1.8"/><path d="M12 10.7V8"/><path d="M10.2 2.2l3.6 3.6M13.8 2.2l-3.6 3.6"/>',
  prDraft: '<circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><path d="M4 5.3v5.4"/><circle cx="12" cy="12.5" r="1.8"/><path d="M12 9.5v-.8M12 6.5v-.8M12 3.5v-.8"/>',
  issueOpen: '<circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/>',
  issueClosed: '<circle cx="8" cy="8" r="6.2"/><path d="M5.2 8.2l2 2 3.6-4"/>',
  check: '<path d="M3 8.5l3.2 3.2L13 4.8"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  dot: '<circle cx="8" cy="8" r="3.2" fill="currentColor"/>',
  skip: '<circle cx="8" cy="8" r="6.2"/><path d="M3.8 12.2l8.4-8.4"/>',
  comment: '<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/>',
  commit: '<circle cx="8" cy="8" r="2.6"/><path d="M1 8h4.4M10.6 8H15"/>',
  clock: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.4 1.6"/>',
  eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
  play: '<circle cx="8" cy="8" r="6.2"/><path d="M6.6 5.4v5.2L10.6 8z" fill="currentColor"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  caret: '<path d="M4.5 6.5L8 10l3.5-3.5"/>',
  file: '<path d="M4 1.8h5l3 3V14H4z"/><path d="M9 1.8v3h3"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 6.6c0 2.8-7 1.6-7 4.3"/>',
};
function icon(name: string, cls = ''): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="gi ${cls}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstChild as SVGSVGElement;
}

/** Profile picture; falls back to the login's initial when the image can't load */
function avatar(login: string, size = 20): HTMLElement {
  const fallback = () => {
    const s = h('span', { className: 'g-avatar g-avatar-ph', title: login }, (login.replace(/^app\//, '')[0] ?? '?').toUpperCase());
    s.style.width = s.style.height = `${size}px`;
    s.style.fontSize = `${Math.round(size * 0.5)}px`;
    return s;
  };
  if (!/^[\w.-]+(\[bot\])?$/.test(login)) return fallback();
  const img = h('img', { className: 'g-avatar', alt: '', title: login, width: size, height: size, loading: 'lazy',
    src: `${AVATAR_HOST}${encodeURIComponent(login.replace(/\[bot\]$/, ''))}?s=${size * 2}&v=4` });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

const MIN = 60, HOUR = 3600, DAY = 86400;
/** "3 hours ago", like GitHub; older than a month gives the date */
function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!(s >= 0)) return iso;
  if (s < 45) return 'just now';
  const unit = (v: number, u: string) => `${v} ${u}${v === 1 ? '' : 's'} ago`;
  if (s < HOUR) return unit(Math.max(1, Math.round(s / MIN)), 'minute');
  if (s < DAY) return unit(Math.round(s / HOUR), 'hour');
  if (s < 2 * DAY) return 'yesterday';
  if (s < 30 * DAY) return unit(Math.round(s / DAY), 'day');
  return `on ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}
const dayFmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function duration(from?: string | null, to?: string | null): string {
  const s = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 1000) : NaN;
  if (!(s >= 0)) return '';
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function labelPill(l: Label): HTMLElement {
  const el = h('span', { className: 'g-label-pill', title: l.name }, l.name);
  el.style.setProperty('--lc', `#${l.color}`);
  return el;
}

/** Rendered GitHub Markdown, rebuilt from the allowlist */
function mdBlock(html: string, empty = 'No description provided.'): HTMLElement {
  const el = h('div', { className: 'g-md' });
  if (html.trim()) el.append(sanitize(html));
  else el.append(h('p', { className: 'g-muted' }, h('em', {}, empty)));
  // GitHub alerts: a blockquote starting "[!NOTE]" (TIP, IMPORTANT, WARNING, CAUTION) becomes a callout
  for (const q of Array.from(el.querySelectorAll('blockquote'))) {
    const first = q.firstElementChild;
    const m = first && /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.textContent ?? '');
    if (!first || !m) continue;
    const kind = m[1].toLowerCase();
    const textNode = Array.from(first.childNodes).find((c) => c.nodeType === Node.TEXT_NODE && /\[!/.test(c.textContent ?? ''));
    if (textNode) textNode.textContent = (textNode.textContent ?? '').replace(/^\s*\[![A-Z]+\]\s*/i, '');
    q.classList.add('g-alert', `g-alert-${kind}`);
    q.prepend(h('p', { className: 'g-alert-title' }, kind[0].toUpperCase() + kind.slice(1)));
  }
  return el;
}

const strong = (t: string) => h('strong', {}, t);
const branchPill = (name: string) => h('span', { className: 'g-branch' }, name);

/** PR or issue state badge: icon + word, colored like GitHub */
function statePill(kind: 'pr' | 'issue', state: string, draft = false): HTMLElement {
  const s = draft && state === 'OPEN' ? 'DRAFT' : state;
  const [ic, word, cls] = kind === 'issue'
    ? s === 'OPEN' ? ['issueOpen', 'Open', 'open'] : ['issueClosed', 'Closed', 'done']
    : ({ OPEN: ['prOpen', 'Open', 'open'], DRAFT: ['prDraft', 'Draft', 'draft'], MERGED: ['prMerged', 'Merged', 'done'], CLOSED: ['prClosed', 'Closed', 'closed'] } as Record<string, string[]>)[s] ?? ['prOpen', s, 'open'];
  return h('span', { className: `g-state g-state-${cls}` }, icon(ic), word);
}
function stateIcon(kind: 'pr' | 'issue', state: string, draft = false): SVGSVGElement {
  if (kind === 'issue') return state === 'OPEN' ? icon('issueOpen', 'g-c-open') : icon('issueClosed', 'g-c-done');
  if (state === 'MERGED') return icon('prMerged', 'g-c-done');
  if (state === 'CLOSED') return icon('prClosed', 'g-c-closed');
  return draft ? icon('prDraft', 'g-c-muted') : icon('prOpen', 'g-c-open');
}
function checkIcon(state: string | null): SVGSVGElement | '' {
  if (state === 'pass') return icon('check', 'g-c-open');
  if (state === 'fail') return icon('x', 'g-c-closed');
  if (state === 'pending') return icon('dot', 'g-c-wait');
  if (state === 'skip' || state === 'neutral') return icon('skip', 'g-c-muted');
  return '';
}
/** Workflow run / job / step status, from GitHub's status + conclusion */
function runIcon(status: string, conclusion: string): SVGSVGElement {
  if (status && status !== 'completed') return icon('dot', 'g-c-wait g-pulse');
  if (conclusion === 'success') return icon('check', 'g-c-open');
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') return icon('x', 'g-c-closed');
  return icon('skip', 'g-c-muted');
}

/** GitHub's five-square +/- bar */
function diffstat(add: number, del: number): HTMLElement {
  const total = add + del;
  const g = total ? Math.round((add / total) * 5) : 0, r = total ? Math.min(5 - g, Math.round((del / total) * 5)) : 0;
  return h('span', { className: 'g-diffstat' },
    h('span', { className: 'g-c-open' }, `+${add.toLocaleString()}`), ' ', h('span', { className: 'g-c-closed' }, `−${del.toLocaleString()}`), ' ',
    ...Array.from({ length: 5 }, (_, i) => h('span', { className: `g-sq ${i < g ? 'g-sq-add' : i < g + r ? 'g-sq-del' : ''}` })));
}

/** Commits grouped by day with GitHub's "Commits on <date>" headings */
function commitHistory(commits: GhCommit[], newestFirst: boolean): HTMLElement {
  const list = newestFirst ? commits : [...commits].reverse();
  const groups = new Map<string, GhCommit[]>();
  for (const c of list) {
    const k = dayFmt(c.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  return h('div', { className: 'g-history' }, ...[...groups].map(([day, cs]) => h('div', { className: 'g-history-day' },
    h('div', { className: 'g-history-head' }, icon('commit', 'g-c-muted'), `Commits on ${day}`),
    h('div', { className: 'g-box' }, ...cs.map((c) => h('div', { className: 'g-box-row g-commit-row2' },
      h('div', { className: 'g-grow' },
        h('div', { className: 'g-row-title' }, c.headline),
        h('div', { className: 'g-row-meta' }, avatar(c.author, 16), strong(c.author), ` committed ${ago(c.date)}`)),
      h('button', { className: 'dm-btn g-sha', title: 'Copy the full SHA', onclick: () => call('copy', { text: c.oid }) }, c.oid.slice(0, 7))))))));
}

function githubView() {
  const nav = h('nav', { className: 'g-gh-nav' });
  const main = h('div', { className: 'dm-view g-gh' });
  body.replaceChildren(nav, main);
  let gen = 0;
  // Links in GitHub text open in the browser; the webview never navigates
  main.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    if (/^(https?|mailto):/i.test(href)) call('openUrl', { url: href });
  });

  const go = (patch: Partial<UiState['gh']>) => { Object.assign(state.gh, patch); save(); load(); };
  const ghAct = async <M extends Method>(label: string, method: M, params: Api[M][0]) => {
    const ok = await act(label, method, params);
    if (ok) load();
    return ok;
  };

  function navTab(section: GhSection, ic: string, label: string, count?: number) {
    const b = h('button', { className: 'g-gh-tab', onclick: () => go({ section, open: undefined, run: undefined, tab: undefined }) },
      icon(ic), label, ...(count !== undefined ? [h('span', { className: 'g-counter' }, String(count))] : []));
    b.setAttribute('aria-selected', String(state.gh.section === section));
    return b;
  }

  async function load() {
    const g = ++gen;
    message(main, 'Loading…');
    try {
      const s = await call('ghState', {});
      if (g !== gen) return;
      if (!s.ok) {
        nav.replaceChildren();
        const cmd = s.reason === 'missing' ? 'https://cli.github.com' : 'gh auth login';
        main.replaceChildren(h('div', { className: 'g-blank' }, icon('branch', 'g-blank-icon'), h('h3', {}, 'Connect GitHub'), h('p', {}, s.message),
          h('p', {}, h('code', { className: 'g-mono' }, cmd), ' ', btn('Copy', 'Copy to the clipboard', () => call('copy', { text: cmd })), ' ', btn('Retry', 'Check again', () => load()))));
        return;
      }
      me = s.user;
      nav.replaceChildren(navTab('prs', 'prOpen', 'Pull requests'), navTab('issues', 'issueOpen', 'Issues'), navTab('actions', 'play', 'Actions'), navTab('commits', 'commit', 'Commits'),
        h('span', { className: 'dm-spacer' }), h('span', { className: 'g-me' }, avatar(s.user, 20), s.user));
      const els = state.gh.section === 'prs' ? await (state.gh.open ? prPage(state.gh.open) : list('pr'))
        : state.gh.section === 'issues' ? await (state.gh.open ? issuePage(state.gh.open) : list('issue'))
        : state.gh.section === 'actions' ? await (state.gh.run ? runPage(state.gh.run) : runList())
        : await commitsPage();
      if (g === gen) main.replaceChildren(h('div', { className: 'g-gh-inner' }, ...els));
    } catch (e) {
      if (g === gen) message(main, (e as Error).message, true);
    }
  }

  // ── Lists ──

  async function list(kind: 'pr' | 'issue'): Promise<Node[]> {
    const isPr = kind === 'pr';
    const filter = isPr ? state.gh.prFilter : '';
    const search = isPr ? '' : state.gh.issueSearch;
    const listState = state.gh.listState;
    const [items, counts] = await Promise.all([
      isPr ? call('prList', { state: listState, filter: state.gh.prFilter }) : call('issueList', { state: listState, search }),
      call('counts', { kind, filter, search }).catch(() => null),
    ]);

    const filterSel = isPr ? h('select', { className: 'dm-btn', title: 'Filter',
      onchange: () => go({ prFilter: filterSel!.value as UiState['gh']['prFilter'] }) },
    ...([['open', 'All'], ['mine', 'Created by me'], ['review', 'Review requested']] as const).map(([v, t]) => h('option', { value: v, selected: state.gh.prFilter === v }, t))) : null;
    const q = isPr ? null : h('input', { className: 'dm-input g-q', type: 'search', placeholder: 'Filter issues (GitHub search, Enter)', value: state.gh.issueSearch });
    q?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go({ issueSearch: q.value }); });
    const newBtn = btn(isPr ? 'New pull request' : 'New issue', isPr ? 'Create a pull request from the current branch' : 'Create an issue',
      () => (isPr ? newPr() : newIssue()), 'g-btn-green');

    const toggle = (st: 'open' | 'closed') => {
      const n = counts ? counts[st] : null;
      const b = h('button', { className: 'g-toggle', onclick: () => go({ listState: st }) },
        isPr ? icon(st === 'open' ? 'prOpen' : 'check') : icon(st === 'open' ? 'issueOpen' : 'check'),
        `${n === null ? '' : n.toLocaleString() + ' '}${st === 'open' ? 'Open' : 'Closed'}`);
      b.setAttribute('aria-pressed', String(listState === st));
      return b;
    };

    const rows = items.map((it) => {
      const pr = isPr ? (it as PrItem) : null;
      const meta = pr && pr.state === 'MERGED' ? `#${it.number} by ${it.author} was merged ${ago(it.updatedAt)}`
        : it.state !== 'OPEN' ? `#${it.number} by ${it.author} was closed ${ago(it.updatedAt)}`
        : `#${it.number} opened ${ago(it.createdAt)} by ${it.author}${pr?.isDraft ? ' • Draft' : ''}`;
      const review = pr?.reviewDecision === 'APPROVED' ? 'Approved' : pr?.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested'
        : pr?.reviewDecision === 'REVIEW_REQUIRED' ? 'Review required' : '';
      return h('button', { className: 'g-box-row g-list-row', onclick: () => go({ open: it.number, tab: undefined }) },
        h('span', { className: 'g-row-icon' }, stateIcon(kind, it.state, pr?.isDraft)),
        h('span', { className: 'g-grow' },
          h('span', { className: 'g-row-title' }, it.title, ...(pr ? [' ', checkIcon(pr.checks)] : []), ...it.labels.map(labelPill)),
          h('span', { className: 'g-row-meta' }, meta, ...(review ? [' • ', review] : []))),
        h('span', { className: 'g-row-side' }, ...(it.comments ? [icon('comment'), String(it.comments)] : [])));
    });

    return [
      h('div', { className: 'g-subhead' }, ...(filterSel ? [filterSel] : []), ...(q ? [q] : []), h('span', { className: 'dm-spacer' }), newBtn),
      h('div', { className: 'g-box' },
        h('div', { className: 'g-box-head' }, toggle('open'), toggle('closed')),
        ...(rows.length ? rows : [h('div', { className: 'g-blank' }, isPr ? icon('prOpen', 'g-blank-icon') : icon('issueOpen', 'g-blank-icon'),
          h('h3', {}, `No ${listState} ${isPr ? 'pull requests' : 'issues'}${isPr && state.gh.prFilter !== 'open' ? ' for this filter' : ''}`))])),
    ];
  }

  async function newPr() {
    const [base, last] = await Promise.all([call('defaultBase', {}).catch(() => ''), call('lastMessage', {}).catch(() => '')]);
    const v = await form(`Open a pull request from ${overview?.status.branch ?? 'HEAD'}`, [
      { key: 'title', label: 'Title', value: last.split('\n')[0] },
      { key: 'body', label: 'Description (Markdown)', kind: 'textarea' },
      { key: 'base', label: 'Base branch', value: base },
      { key: 'labels', label: 'Labels (comma-separated)' },
      { key: 'draft', label: 'Create as draft', kind: 'check' },
    ], 'Create pull request');
    if (!v) return;
    busy.textContent = 'Creating pull request…';
    try {
      const url = await call('prCreate', { title: String(v.title), body: String(v.body), base: String(v.base), draft: !!v.draft, labels: String(v.labels).split(',') });
      prHeads = null;
      go({ open: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined, tab: undefined });
    } catch (e) {
      showError(`Create pull request failed: ${(e as Error).message}`);
    } finally {
      busy.textContent = '';
    }
  }

  async function newIssue() {
    const v = await form('New issue', [{ key: 'title', label: 'Title' }, { key: 'body', label: 'Description (Markdown)', kind: 'textarea' },
      { key: 'labels', label: 'Labels (comma-separated)' }], 'Submit new issue');
    if (!v) return;
    try {
      const url = await call('issueCreate', { title: String(v.title), body: String(v.body), labels: String(v.labels).split(',') });
      go({ open: Number(/\/issues\/(\d+)/.exec(url)?.[1]) || undefined });
    } catch (e) {
      showError(`Create issue failed: ${(e as Error).message}`);
    }
  }

  // ── Conversation pieces ──

  function commentCard(author: string, date: string, html: string, badge = '', verb = 'commented'): HTMLElement {
    return h('div', { className: 'g-tl-item' },
      h('div', { className: 'g-tl-avatar' }, avatar(author, 40)),
      h('div', { className: 'g-card' },
        h('div', { className: 'g-card-head' }, strong(author), ` ${verb} ${ago(date)}`,
          ...(badge ? [h('span', { className: 'dm-spacer' }), h('span', { className: 'g-role' }, badge)] : [])),
        h('div', { className: 'g-card-body' }, mdBlock(html, 'No description provided.'))));
  }

  function timelineView(items: TimelineItem[], author: string): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'comment') { out.push(commentCard(it.author, it.date, it.bodyHtml ?? '', it.author === author ? 'Author' : '')); continue; }
      if (it.kind === 'commit') {
        // Consecutive commits by one person collapse into "added N commits", as on GitHub
        const run = [it];
        while (items[i + 1]?.kind === 'commit' && items[i + 1].author === it.author) run.push(items[++i]);
        out.push(h('div', { className: 'g-tl-event' }, h('span', { className: 'g-tl-badge' }, icon('commit')),
          h('div', { className: 'g-grow' },
            h('div', {}, avatar(it.author, 20), ' ', strong(it.author), ` added ${run.length} commit${run.length === 1 ? '' : 's'} ${ago(run[run.length - 1].date)}`),
            ...run.map((c) => h('div', { className: 'g-tl-commit' }, icon('commit', 'g-c-muted'), h('span', { className: 'g-grow' }, c.commit!.headline),
              h('span', { className: 'g-mono g-muted' }, c.commit!.oid.slice(0, 7)))))));
        continue;
      }
      const st = it.state ?? '';
      const [ic, cls, verb] = st === 'APPROVED' ? ['check', 'g-badge-open', 'approved these changes']
        : st === 'CHANGES_REQUESTED' ? ['x', 'g-badge-closed', 'requested changes'] : st === 'DISMISSED' ? ['skip', '', 'had a review dismissed'] : ['eye', '', 'reviewed'];
      out.push(h('div', { className: 'g-tl-event' }, h('span', { className: `g-tl-badge ${cls}` }, icon(ic)),
        h('div', { className: 'g-grow' }, h('div', {}, avatar(it.author, 20), ' ', strong(it.author), ` ${verb} ${ago(it.date)}`))));
      if (it.bodyHtml?.trim()) out.push(commentCard(it.author, it.date, it.bodyHtml, '', 'left a review'));
    }
    return out;
  }

  function composer(placeholder: string, extra: (getBody: () => string) => HTMLElement[], send: (body: string) => Promise<boolean>): HTMLElement {
    const ta = h('textarea', { className: 'g-field g-composer-ta', rows: 5, placeholder });
    return h('div', { className: 'g-tl-item g-composer' },
      h('div', { className: 'g-tl-avatar' }, avatar(me ?? '?', 40)),
      h('div', { className: 'g-card' },
        h('div', { className: 'g-card-head g-tabs-mini' }, h('span', { className: 'g-tab-mini' }, 'Write'), h('span', { className: 'g-muted' }, 'Markdown is supported')),
        h('div', { className: 'g-card-body' }, ta,
          h('div', { className: 'g-composer-btns' }, ...extra(() => ta.value),
            btn('Comment', 'Add a comment', async () => { if (await send(ta.value)) ta.value = ''; }, 'g-btn-green')))));
  }

  function sidebar(sections: [string, Node[]][]): HTMLElement {
    return h('aside', { className: 'g-sidebar' }, ...sections.map(([title, items]) => h('div', { className: 'g-side-sec' },
      h('div', { className: 'g-side-title' }, title), ...(items.length ? items : [h('div', { className: 'g-muted' }, 'None yet')]))));
  }

  // ── Pull request page ──

  async function prPage(num: number): Promise<Node[]> {
    const p = await call('prView', { number: num });
    const tab = state.gh.tab ?? 'conversation';
    const open = p.state === 'OPEN';
    const commitsN = p.commits.length;
    const failing = p.checkRuns.filter((c) => c.state === 'fail').length;
    const pendingN = p.checkRuns.filter((c) => c.state === 'pending').length;

    const tabBtn = (id: NonNullable<UiState['gh']['tab']>, ic: string, label: string, count: number) => {
      const b = h('button', { className: 'g-pr-tab', onclick: () => go({ tab: id }) }, icon(ic), label, h('span', { className: 'g-counter' }, String(count)));
      b.setAttribute('aria-selected', String(tab === id));
      return b;
    };
    const sentence = p.state === 'MERGED'
      ? [strong(p.author), ` merged ${commitsN} commit${commitsN === 1 ? '' : 's'} into `, branchPill(p.baseRefName), ' from ', branchPill(p.headRefName), ` ${ago(p.mergedAt)}`]
      : [strong(p.author), ` ${open ? 'wants to merge' : 'proposed merging'} ${commitsN} commit${commitsN === 1 ? '' : 's'} into `, branchPill(p.baseRefName), ' from ', branchPill(p.headRefName)];

    const header = [
      h('div', { className: 'g-back' }, h('button', { className: 'g-link', onclick: () => go({ open: undefined, tab: undefined }) }, '← Pull requests')),
      h('div', { className: 'g-title-row' },
        h('h1', { className: 'g-title-big' }, p.title, ' ', h('span', { className: 'g-muted g-title-num' }, `#${p.number}`)),
        h('div', { className: 'g-title-btns' },
          btn('Checkout', `gh pr checkout ${p.number}`, () => act('Checkout', 'prCheckout', { number: num })),
          btn('Open on GitHub', p.url, () => call('openUrl', { url: p.url })))),
      h('div', { className: 'g-subtitle' }, statePill('pr', p.state, p.isDraft), h('span', {}, ...sentence)),
      h('div', { className: 'g-pr-tabs' },
        tabBtn('conversation', 'comment', 'Conversation', p.timeline.filter((t) => t.kind !== 'commit').length + 0),
        tabBtn('commits', 'commit', 'Commits', commitsN),
        tabBtn('checks', 'check', 'Checks', p.checkRuns.length),
        tabBtn('files', 'file', 'Files changed', p.changedFiles),
        h('span', { className: 'dm-spacer' }), diffstat(p.additions, p.deletions)),
    ];

    let content: Node[];
    if (tab === 'commits') content = [commitHistory(p.commits, false)];
    else if (tab === 'checks') content = [checksList(p.checkRuns)];
    else if (tab === 'files') content = filesTab(p);
    else {
      content = [h('div', { className: 'g-pr-layout' },
        h('div', { className: 'g-pr-main' },
          h('div', { className: 'g-timeline' },
            commentCard(p.author, p.createdAt, p.bodyHtml, 'Author'),
            ...timelineView(p.timeline, p.author),
            mergeBox(p, failing, pendingN),
            composer('Leave a comment', () => p.state === 'MERGED' ? [] : [
              open
                ? btn('Close pull request', 'gh pr close', async () => {
                  if (await confirmBox(`Close #${num}?`, 'Closes the pull request without merging. You can reopen it later.', 'Close pull request', true)) ghAct('Close pull request', 'prSetState', { number: num, open: false });
                }, 'g-btn-close')
                : btn('Reopen pull request', 'gh pr reopen', () => ghAct('Reopen pull request', 'prSetState', { number: num, open: true })),
            ], (b) => ghAct('Comment', 'prComment', { number: num, body: b })))),
        sidebar([
          ['Reviewers', p.reviewers.map((r) => h('div', { className: 'g-side-row' }, avatar(r.login, 20), h('span', { className: 'g-grow' }, r.login),
            r.state === 'APPROVED' ? icon('check', 'g-c-open') : r.state === 'CHANGES_REQUESTED' ? icon('x', 'g-c-closed') : r.state === 'PENDING' ? icon('dot', 'g-c-wait') : icon('eye', 'g-c-muted')))],
          ['Labels', p.labels.length ? [h('div', { className: 'g-side-labels' }, ...p.labels.map(labelPill))] : []],
          ['Development', [h('div', { className: 'g-side-row' }, icon('branch', 'g-c-muted'), branchPill(p.headRefName))]],
        ]))];
    }
    return [...header, ...content];
  }

  function checksList(runs: CheckRun[]): HTMLElement {
    if (!runs.length) return h('div', { className: 'g-box' }, h('div', { className: 'g-blank' }, icon('check', 'g-blank-icon'), h('h3', {}, 'No checks reported')));
    return h('div', { className: 'g-box' }, ...runs.map((c) => h('div', { className: 'g-box-row' },
      h('span', { className: 'g-row-icon' }, checkIcon(c.state)),
      h('span', { className: 'g-grow' }, h('span', { className: 'g-row-title' }, c.workflow ? `${c.workflow} / ${c.name}` : c.name),
        h('span', { className: 'g-row-meta' }, c.state === 'pass' ? `Successful${c.seconds !== null ? ` in ${c.seconds}s` : ''}`
          : c.state === 'fail' ? `Failing${c.seconds !== null ? ` after ${c.seconds}s` : ''}` : c.state === 'pending' ? 'In progress' : 'Skipped or neutral')),
      ...(c.url ? [btn('Details', c.url, () => call('openUrl', { url: c.url }), 'g-small')] : []))));
  }

  function mergeBox(p: PrDetail, failing: number, pending: number): HTMLElement {
    const num = p.number;
    if (p.state === 'MERGED') {
      return h('div', { className: 'g-tl-item' }, h('div', { className: 'g-tl-avatar' }, h('span', { className: 'g-merge-badge g-bg-done' }, icon('prMerged'))),
        h('div', { className: 'g-card g-merge g-merge-done' }, h('div', { className: 'g-merge-sec' }, h('strong', {}, 'Pull request successfully merged and closed'),
          h('div', { className: 'g-muted' }, `${p.headRefName} was merged into ${p.baseRefName} ${ago(p.mergedAt)}.`))));
    }
    if (p.state === 'CLOSED') {
      return h('div', { className: 'g-tl-item' }, h('div', { className: 'g-tl-avatar' }, h('span', { className: 'g-merge-badge g-bg-closed' }, icon('prClosed'))),
        h('div', { className: 'g-card g-merge' }, h('div', { className: 'g-merge-sec' }, h('strong', {}, 'Closed with unmerged commits'),
          h('div', { className: 'g-muted' }, 'This pull request is closed, but its branch still has commits. Reopen it below to merge.'))));
    }
    const total = p.checkRuns.length;
    const checksRow = !total ? null : h('details', { className: 'g-merge-sec' },
      h('summary', {}, checkIcon(failing ? 'fail' : pending ? 'pending' : 'pass'),
        h('span', {}, h('strong', {}, failing ? 'Some checks were not successful' : pending ? 'Some checks haven’t completed yet' : 'All checks have passed'),
          h('span', { className: 'g-muted' }, ` ${[failing && `${failing} failing`, pending && `${pending} in progress`, `${total - failing - pending} successful`].filter(Boolean).join(', ')} check${total === 1 ? '' : 's'}`)),
        h('span', { className: 'dm-spacer' }), h('span', { className: 'g-link' }, 'Show all checks')),
      checksList(p.checkRuns));
    const review = p.reviewDecision === 'APPROVED' ? ['check', 'g-c-open', 'Changes approved', 'This pull request has an approving review.']
      : p.reviewDecision === 'CHANGES_REQUESTED' ? ['x', 'g-c-closed', 'Changes requested', 'A reviewer asked for changes before merging.']
      : p.reviewDecision === 'REVIEW_REQUIRED' ? ['dot', 'g-c-wait', 'Review required', 'At least one approving review is required by the repository.'] : null;
    const conflict = p.mergeable === 'CONFLICTING';
    const unknown = p.mergeable === 'UNKNOWN';

    let method: 'merge' | 'squash' | 'rebase' = 'merge';
    const LABEL = { merge: 'Merge pull request', squash: 'Squash and merge', rebase: 'Rebase and merge' } as const;
    const action = h('div', { className: 'g-merge-sec g-merge-action' });
    const drawButtons = () => {
      if (p.isDraft) {
        action.replaceChildren(h('div', { className: 'g-grow' }, h('strong', {}, 'This pull request is still a work in progress'),
          h('div', { className: 'g-muted' }, 'Draft pull requests cannot be merged.')),
        btn('Ready for review', 'gh pr ready', () => ghAct('Ready for review', 'prReady', { number: num })));
        return;
      }
      const mainBtn = btn(LABEL[method], `gh pr merge --${method}`, () => confirmStep(), 'g-btn-green g-split-main');
      const caret = h('button', { className: 'dm-btn g-btn-green g-split-caret', title: 'Choose a merge method',
        onclick: (e: MouseEvent) => menu(e, (['merge', 'squash', 'rebase'] as const).map((m) => ({
          label: `${m === method ? '✓ ' : ''}${LABEL[m] === 'Merge pull request' ? 'Create a merge commit' : LABEL[m]}`,
          run: () => { method = m; drawButtons(); },
        }))) }, icon('caret'));
      mainBtn.disabled = conflict;
      caret.disabled = conflict;
      action.replaceChildren(h('span', { className: 'g-split' }, mainBtn, caret),
        h('span', { className: 'g-muted' }, conflict ? 'Resolve the conflicts first.' : 'Merges on GitHub through gh.'));
    };
    const confirmStep = () => {
      const del = h('input', { type: 'checkbox', checked: true });
      action.replaceChildren(h('div', { className: 'g-grow' },
        h('strong', {}, `${LABEL[method]} #${num}?`),
        h('label', { className: 'g-check' }, del, `Delete the ${p.headRefName} branch after merging`)),
      btn(`Confirm ${method === 'merge' ? 'merge' : method === 'squash' ? 'squash and merge' : 'rebase and merge'}`, 'Merge now',
        () => ghAct('Merge pull request', 'prMerge', { number: num, method, deleteBranch: del.checked }), 'g-btn-green'),
      btn('Cancel', 'Back', () => drawButtons()));
    };
    drawButtons();

    return h('div', { className: 'g-tl-item' },
      h('div', { className: 'g-tl-avatar' }, h('span', { className: `g-merge-badge ${conflict || failing ? 'g-bg-muted' : 'g-bg-open'}` }, icon('prMerged'))),
      h('div', { className: 'g-card g-merge' },
        ...(review ? [h('div', { className: 'g-merge-sec' }, icon(review[0], review[1]), h('span', {}, h('strong', {}, review[2]), h('div', { className: 'g-muted' }, review[3])))] : []),
        ...(checksRow ? [checksRow] : []),
        h('div', { className: 'g-merge-sec' }, conflict ? icon('x', 'g-c-closed') : unknown ? icon('dot', 'g-c-wait') : icon('check', 'g-c-open'),
          h('span', {}, h('strong', {}, conflict ? 'This branch has conflicts that must be resolved' : unknown ? 'Checking for the ability to merge automatically…' : 'This branch has no conflicts with the base branch'),
            h('div', { className: 'g-muted' }, conflict ? 'Use the command line or GitHub to resolve them.' : unknown ? 'Refresh in a moment.' : 'Merging can be performed automatically.'))),
        action));
  }

  function filesTab(p: PrDetail): Node[] {
    const box = h('div', {});
    const reviewBtn = btn('Review changes', 'Comment, approve or request changes', (e) => {
      const ta = h('textarea', { className: 'g-field', rows: 4, placeholder: 'Leave a comment' });
      const radios = (['comment', 'approve', 'request-changes'] as const).map((v, i) => {
        const r = h('input', { type: 'radio', name: 'g-review', value: v, checked: i === 0 });
        const text = { comment: ['Comment', 'Submit general feedback without explicit approval.'], approve: ['Approve', 'Give your approval to merge these changes.'],
          'request-changes': ['Request changes', 'Submit feedback that must be addressed before merging.'] }[v];
        return h('label', { className: 'g-radio' }, r, h('span', {}, h('strong', {}, text[0]), h('div', { className: 'g-muted' }, text[1])));
      });
      const box2 = modal('Finish your review', [ta, ...radios], [btn('Cancel', 'Cancel', () => closeOverlays()),
        btn('Submit review', 'gh pr review', () => {
          const v = (box2.querySelector('input[name="g-review"]:checked') as HTMLInputElement).value as 'comment' | 'approve' | 'request-changes';
          closeOverlays();
          ghAct('Review', 'prReview', { number: p.number, action: v, body: ta.value });
        }, 'g-btn-green')]);
      e.stopPropagation();
    }, 'g-btn-green');
    (async () => {
      message(box, 'Loading the diff…');
      try {
        const d = await call('prDiff', { number: p.number });
        if (d.kind === 'large') {
          box.replaceChildren(h('div', { className: 'g-blank' }, h('h3', {}, 'This diff is too large to show here'),
            btn('Open on GitHub', `${p.url}/files`, () => call('openUrl', { url: `${p.url}/files` }))));
          return;
        }
        box.replaceChildren(...d.files.map((f) => {
          const name = /^diff --git a\/(.*) b\/(.*)$/.exec(f.header[0])?.[2] ?? f.header[0];
          const add = f.hunks.reduce((s, hk) => s + hk.lines.filter((l) => l[0] === '+').length, 0);
          const del = f.hunks.reduce((s, hk) => s + hk.lines.filter((l) => l[0] === '-').length, 0);
          const diff = h('div', { className: 'g-diff g-file-diff' });
          renderDiff(diff, { kind: f.binary ? 'binary' : 'diff', file: f } as DiffResult, () => call('openUrl', { url: `${p.url}/files` }), []);
          const toggle = h('button', { className: 'g-icon-btn', title: 'Collapse', onclick: () => { diff.hidden = !diff.hidden; toggle.classList.toggle('g-rot', diff.hidden); } }, icon('caret'));
          return h('div', { className: 'g-box g-file-box' }, h('div', { className: 'g-box-head g-file-head2' }, toggle, diffstat(add, del), h('span', { className: 'g-mono g-grow' }, name)), diff);
        }));
      } catch (e) {
        message(box, (e as Error).message, true);
      }
    })();
    return [h('div', { className: 'g-subhead' }, h('span', { className: 'g-muted' }, `${p.changedFiles} file${p.changedFiles === 1 ? '' : 's'} changed`),
      h('span', { className: 'dm-spacer' }), ...(p.state === 'OPEN' ? [reviewBtn] : [])), box];
  }

  // ── Issue page ──

  async function issuePage(num: number): Promise<Node[]> {
    const i = await call('issueView', { number: num });
    const open = i.state === 'OPEN';
    return [
      h('div', { className: 'g-back' }, h('button', { className: 'g-link', onclick: () => go({ open: undefined }) }, '← Issues')),
      h('div', { className: 'g-title-row' },
        h('h1', { className: 'g-title-big' }, i.title, ' ', h('span', { className: 'g-muted g-title-num' }, `#${i.number}`)),
        h('div', { className: 'g-title-btns' }, btn('Open on GitHub', i.url, () => call('openUrl', { url: i.url })))),
      h('div', { className: 'g-subtitle' }, statePill('issue', i.state),
        h('span', {}, strong(i.author), ` opened this issue ${ago(i.createdAt)} · ${i.comments} comment${i.comments === 1 ? '' : 's'}`)),
      h('div', { className: 'g-pr-layout g-issue-layout' },
        h('div', { className: 'g-pr-main' }, h('div', { className: 'g-timeline' },
          commentCard(i.author, i.createdAt, i.bodyHtml, 'Author'),
          ...timelineView(i.timeline, i.author),
          ...(open ? [] : [h('div', { className: 'g-tl-event' }, h('span', { className: 'g-tl-badge g-badge-done' }, icon('issueClosed')),
            h('div', { className: 'g-grow' }, `This issue was closed ${ago(i.closedAt)}`))]),
          composer('Leave a comment', () => [open
            ? btn('Close issue', 'gh issue close', () => ghAct('Close issue', 'issueSetState', { number: num, open: false }), 'g-btn-close')
            : btn('Reopen issue', 'gh issue reopen', () => ghAct('Reopen issue', 'issueSetState', { number: num, open: true }))],
          (b) => ghAct('Comment', 'issueComment', { number: num, body: b })))),
        sidebar([['Labels', i.labels.length ? [h('div', { className: 'g-side-labels' }, ...i.labels.map(labelPill))] : []]])),
    ];
  }

  // ── Actions ──

  async function runList(): Promise<Node[]> {
    const runs = await call('runList', { all: state.gh.allRuns });
    const scope = h('select', { className: 'dm-btn', title: 'Which runs', onchange: () => go({ allRuns: scope.value === 'all' }) },
      h('option', { value: 'branch', selected: !state.gh.allRuns }, `Branch: ${overview?.status.branch ?? 'current'}`),
      h('option', { value: 'all', selected: state.gh.allRuns }, 'All branches'));
    return [
      h('div', { className: 'g-subhead' }, h('h2', { className: 'g-h2' }, 'All workflows'), h('span', { className: 'dm-spacer' }), scope),
      h('div', { className: 'g-box' },
        h('div', { className: 'g-box-head' }, h('strong', {}, `${runs.length}${runs.length === 50 ? '+' : ''} workflow run${runs.length === 1 ? '' : 's'}`)),
        ...(runs.length ? runs.map((r) => h('button', { className: 'g-box-row g-list-row', onclick: () => go({ run: r.databaseId, job: undefined }) },
          h('span', { className: 'g-row-icon' }, runIcon(r.status, r.conclusion)),
          h('span', { className: 'g-grow' }, h('span', { className: 'g-row-title' }, r.displayTitle),
            h('span', { className: 'g-row-meta' }, h('strong', {}, r.workflowName), ` #${r.number}: ${r.event.replace(/_/g, ' ')}`)),
          h('span', { className: 'g-row-side g-run-side' }, branchPill(r.headBranch),
            h('span', { className: 'g-muted' }, icon('clock'), ` ${ago(r.createdAt)}`),
            h('span', { className: 'g-muted' }, duration(r.createdAt, r.updatedAt)))))
          : [h('div', { className: 'g-blank' }, icon('play', 'g-blank-icon'), h('h3', {}, 'No workflow runs'),
            h('p', { className: 'g-muted' }, state.gh.allRuns ? 'This repository has no runs yet.' : 'Nothing has run on this branch. Pick All branches above.'))])),
    ];
  }

  async function runPage(id: number): Promise<Node[]> {
    const r = await call('runView', { id });
    const failed = r.conclusion === 'failure';
    const job = r.jobs.find((j) => j.databaseId === state.gh.job) ?? r.jobs.find((j) => j.conclusion === 'failure') ?? r.jobs[0];
    const rerun = (e: MouseEvent) => menu(e, [
      { label: 'Re-run failed jobs', disabled: !failed, run: () => ghAct('Re-run', 'runRerun', { id, failedOnly: true }) },
      { label: 'Re-run all jobs', disabled: r.status !== 'completed', run: () => ghAct('Re-run', 'runRerun', { id, failedOnly: false }) },
    ]);
    const steps = !job ? [] : job.steps.map((s) => {
      const log = h('pre', { className: 'g-log', hidden: true });
      const head = h('button', { className: 'g-step', onclick: async () => {
        log.hidden = !log.hidden;
        head.classList.toggle('g-open', !log.hidden);
        if (log.hidden) { log.replaceChildren(); return; }
        log.textContent = 'Loading…';
        try {
          const text = await call('jobLog', { jobId: job.databaseId, step: s.name });
          log.replaceChildren(...(text ? text.split('\n') : ['No log output for this step.']).map((line, k) =>
            h('div', { className: `g-log-line${/^##\[error\]/.test(line) ? ' g-log-error' : /^##\[warning\]/.test(line) ? ' g-log-warn' : ''}` },
              h('span', { className: 'g-log-n' }, String(k + 1)), line.replace(/^##\[(error|warning|notice|debug)\]/, ''))));
        } catch (e) {
          log.textContent = (e as Error).message;
        }
      } }, icon('chevron', 'g-step-chev'), runIcon(s.status, s.conclusion), h('span', { className: 'g-grow' }, s.name),
      h('span', { className: 'g-muted' }, duration(s.startedAt, s.completedAt)));
      return h('div', {}, head, log);
    });
    return [
      h('div', { className: 'g-back' }, h('button', { className: 'g-link', onclick: () => go({ run: undefined, job: undefined }) }, '← All workflows')),
      h('div', { className: 'g-title-row' },
        h('h1', { className: 'g-title-big' }, runIcon(r.status, r.conclusion), ' ', r.displayTitle, ' ', h('span', { className: 'g-muted g-title-num' }, `${r.workflowName} #${r.number}`)),
        h('div', { className: 'g-title-btns' }, btn('Re-run jobs', 'gh run rerun', rerun), btn('Open on GitHub', r.url, () => call('openUrl', { url: r.url })))),
      h('div', { className: 'g-box g-run-summary' },
        h('div', {}, h('div', { className: 'g-muted' }, `Triggered via ${r.event.replace(/_/g, ' ')} ${ago(r.createdAt)}`), branchPill(r.headBranch), ' ', h('span', { className: 'g-mono g-muted' }, r.headSha.slice(0, 7))),
        h('div', {}, h('div', { className: 'g-muted' }, 'Status'), h('strong', {}, r.status === 'completed' ? (r.conclusion || 'completed').replace(/_/g, ' ') : r.status.replace(/_/g, ' '))),
        h('div', {}, h('div', { className: 'g-muted' }, 'Total duration'), h('strong', {}, duration(r.createdAt, r.updatedAt) || '—'))),
      h('div', { className: 'g-run-layout' },
        h('nav', { className: 'g-jobs' }, h('div', { className: 'g-side-title' }, 'Jobs'),
          ...r.jobs.map((j) => {
            const b = h('button', { className: 'g-job', onclick: () => go({ job: j.databaseId }) }, runIcon(j.status, j.conclusion), h('span', { className: 'g-grow' }, j.name),
              h('span', { className: 'g-muted' }, duration(j.startedAt, j.completedAt)));
            b.setAttribute('aria-selected', String(j === job));
            return b;
          })),
        h('div', { className: 'g-box g-job-box' },
          h('div', { className: 'g-box-head' }, ...(job ? [h('strong', {}, job.name), h('span', { className: 'g-muted' }, ` ${job.conclusion ? `${job.conclusion} ` : ''}${ago(job.completedAt || job.startedAt)}`)] : ['No jobs'])),
          ...steps)),
    ];
  }

  // ── Commits ──

  async function commitsPage(): Promise<Node[]> {
    const { branch, commits } = await call('ghCommits', {});
    return [
      h('div', { className: 'g-subhead' }, h('h2', { className: 'g-h2' }, 'Commits'), branchPill(branch),
        h('span', { className: 'g-muted' }, branch === overview?.status.branch ? '' : '(your branch isn’t on GitHub yet; showing the default branch)')),
      commits.length ? commitHistory(commits, true) : h('div', { className: 'g-blank' }, h('h3', {}, 'No commits')),
    ];
  }

  return { refresh: load };
}

/** The signed-in gh user, for the comment composer's avatar */
let me: string | null = null;

// ── Start ─────────────────────────────────────────────────────────────

loadOverview().catch((e) => showError((e as Error).message));
setView(state.view);
