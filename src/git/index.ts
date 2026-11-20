// The darkmark Git panel, host side. Bundled to out/git.js and required only when the panel
// first opens, so Markdown-only users never load it.
import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { shell, viewerCsp } from '../webviewShell';
import { allChanges, parseDiff, partialPatch } from './diff';
import { Git, GitError, TooLarge } from './runner';
import { layout, type Lanes } from './graph';
import { LOG_FORMAT, LogParser, type Commit } from './log';
import type { Api, BlameLine, ChangedFile, DiffResult, Event, Method, Op, Overview, Ref, Request, Response } from './protocol';
import { Gh } from '../github/gh';
import { githubHandlers } from '../github/handlers';
import { rebasePlan } from './rebase';
import { parseStatus } from './status';

const PAGE = 300;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 5000;
const MAX_BLAME_LINES = 100_000;

type View = Extract<Event, { event: 'show' }>['view'];
let panel: GitPanel | undefined;

/** Open (or reveal) the one Git panel, on the repository of `uri` or of the active file */
export async function open(context: vscode.ExtensionContext, uri?: vscode.Uri, view: View = 'graph'): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  const folder = (target && vscode.workspace.getWorkspaceFolder(target)) ?? vscode.workspace.workspaceFolders?.[0];
  const cwd = target?.scheme === 'file' && view !== 'graph' && view !== 'changes'
    ? path.dirname(target.fsPath)
    : folder?.uri.fsPath ?? (target?.scheme === 'file' ? path.dirname(target.fsPath) : undefined);
  if (!cwd) {
    vscode.window.showInformationMessage('darkmark: open a folder or file inside a Git repository first.');
    return;
  }
  const git = await Git.open(cwd, path.join(context.extensionUri.fsPath, 'out', 'git-editor.js'));
  if (!git) {
    vscode.window.showInformationMessage(`darkmark: no Git repository at ${cwd}.`);
    return;
  }
  const rel = target?.scheme === 'file' ? path.relative(git.root, target.fsPath).split(path.sep).join('/') : undefined;
  if (panel && panel.git.root !== git.root) panel.dispose();
  if (panel) git.dispose();
  panel ??= new GitPanel(context, git);
  panel.reveal(view, view === 'history' || view === 'blame' ? rel : undefined);
}

/** Refuse values that git would read as an option */
function arg(s: string): string {
  if (typeof s !== 'string' || !s || s.startsWith('-')) throw new GitError(`Invalid name: ${s}`);
  return s;
}

class GitPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Graph lanes at the start of each page (keyed by skip), so any page can be laid out again */
  private lanes = new Map<number, Lanes>();
  private stale = false;
  private timer: NodeJS.Timeout | undefined;
  private emptyTree: Promise<string> | undefined;
  // Declared before `handlers`, whose initializer reads it
  private readonly gh = new Gh(this.git.root);

  constructor(private readonly context: vscode.ExtensionContext, readonly git: Git) {
    // No retainContextWhenHidden: a hidden panel frees its renderer and restores from setState
    this.panel = vscode.window.createWebviewPanel('darkmark.git', `Git: ${path.basename(git.root)}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      enableFindWidget: true,
      localResourceRoots: [context.extensionUri],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'logo.png');
    this.panel.webview.html = shell(this.panel.webview, context, {
      title: 'darkmark Git',
      // GitHub avatars are the one remote image source (everything else stays blocked)
      csp: (src, nonce) => viewerCsp()(src, nonce).replace('img-src ', 'img-src https://avatars.githubusercontent.com '),
      styles: [['media', 'viewer.css'], ['out', 'webview', 'git.css']],
      scripts: [['out', 'webview', 'git.js']],
      body: '<div id="app"></div>',
    });

    this.panel.webview.onDidReceiveMessage((m: Request) => this.handle(m), undefined, this.disposables);
    this.panel.onDidChangeViewState(() => {
      if (this.panel.visible && this.stale) this.post({ event: 'refresh' });
    }, undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

    // Refresh when HEAD, the index or refs change, and when a file in the repo is saved
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
      vscode.Uri.file(git.gitDir),
      '{HEAD,index,packed-refs,refs/**,MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge/**,rebase-apply/**}'
    ));
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.changed()),
      watcher.onDidCreate(() => this.changed()),
      watcher.onDidDelete(() => this.changed()),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.scheme === 'file' && !path.relative(git.root, d.uri.fsPath).startsWith('..')) this.changed();
      }),
    );
  }

  reveal(view: View, file?: string): void {
    this.panel.reveal();
    this.post({ event: 'show', view, path: file });
  }

  private changed(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.lanes.clear();
      if (this.panel.visible) this.post({ event: 'refresh' });
      else this.stale = true; // refreshed when shown again
    }, 300);
  }

  private post(m: Event | Response): void {
    if ('event' in m && m.event === 'refresh') this.stale = false;
    this.panel.webview.postMessage(m);
  }

  private async handle(m: Request): Promise<void> {
    if (!m || typeof m.id !== 'number' || !(m.method in this.handlers)) return;
    try {
      const fn = this.handlers[m.method] as (p: unknown) => Promise<unknown>;
      this.post({ id: m.id, result: await fn(m.params ?? {}) });
    } catch (e) {
      this.post({ id: m.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  dispose(): void {
    if (panel === this) panel = undefined;
    clearTimeout(this.timer);
    this.git.dispose(); // kills any running git child
    this.gh.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.panel.dispose();
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private run(args: string[], o?: Parameters<Git['run']>[1]) {
    return this.git.run(args, o);
  }

  private async op(): Promise<Op> {
    const has = (p: string) => existsSync(path.join(this.git.gitDir, p));
    if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
    if (has('MERGE_HEAD')) return 'merge';
    if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (has('REVERT_HEAD')) return 'revert';
    return null;
  }

  private async parents(hash: string): Promise<string[]> {
    return (await this.run(['rev-list', '--parents', '-n', '1', arg(hash), '--'])).trim().split(' ').slice(1);
  }

  /** Base to diff a commit against: its first parent, or the empty tree for a root commit */
  private async base(hash: string): Promise<string> {
    const [p] = await this.parents(hash);
    if (p) return p;
    this.emptyTree ??= this.run(['hash-object', '-t', 'tree', '--stdin'], { input: '' }).then((s) => s.trim());
    return this.emptyTree;
  }

  private async diff(args: string[]): Promise<DiffResult> {
    let text: string;
    try {
      // --no-index exits 1 when the files differ; its output is still the diff
      text = await this.run(args, { maxBytes: MAX_DIFF_BYTES, okCodes: [1] });
    } catch (e) {
      if (e instanceof TooLarge) return { kind: 'large' };
      throw e;
    }
    const [file] = parseDiff(text);
    if (file?.binary) return { kind: 'binary' };
    const lines = file?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0;
    return lines > MAX_DIFF_LINES ? { kind: 'large' } : { kind: 'diff', file: file ?? null };
  }

  private gitUri(file: string, ref: string): vscode.Uri {
    const uri = vscode.Uri.file(path.join(this.git.root, file));
    const api = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI?.(1);
    return api?.toGitUri ? api.toGitUri(uri, ref) : uri;
  }

  /** stash@{n} of the stash with this commit hash right now: positions shift when stashes are added */
  private async stashRef(hash: string): Promise<string> {
    const list = (await this.run(['stash', 'list', '--format=%gd%x00%H'])).split('\n');
    const ref = list.map((l) => l.split('\0')).find(([, h]) => h === hash)?.[0];
    if (!ref) throw new GitError('That stash no longer exists. Refresh and try again.');
    return ref;
  }

  private async defaultRemote(): Promise<string> {
    const remotes = (await this.run(['remote'])).split('\n').filter(Boolean);
    if (!remotes.length) throw new GitError('This repository has no remote.');
    return remotes.includes('origin') ? 'origin' : remotes[0];
  }

  private async log(args: string[], limit: number): Promise<Commit[]> {
    const parser = new LogParser();
    const commits: Commit[] = [];
    await this.git.stream(['log', '-z', `--format=${LOG_FORMAT}`, ...args], (chunk) => {
      commits.push(...parser.push(chunk));
      if (commits.length >= limit) return false;
    });
    return commits.slice(0, limit);
  }

  // ── requests ────────────────────────────────────────────────────────

  private readonly handlers: { [M in Method]: (p: Api[M][0]) => Promise<Api[M][1]> } = {
    ...githubHandlers(this.gh, async () =>
      parseStatus(await this.run(['status', '--porcelain=v2', '--branch', '-z'])).branch),
    overview: async () => {
      const [statusText, refsText, stashText, op] = await Promise.all([
        this.run(['status', '--porcelain=v2', '--branch', '-z']),
        this.run(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(HEAD)%00%(upstream:short)',
          'refs/heads', 'refs/remotes', 'refs/tags']),
        this.run(['stash', 'list', '--format=%gd%x00%H%x00%s']),
        this.op(),
      ]);
      const refs: Ref[] = [];
      for (const line of refsText.split('\n')) {
        const [full, obj, peeled, head, upstream] = line.split('\0');
        if (!full || full.endsWith('/HEAD')) continue;
        const kind = full.startsWith('refs/heads/') ? 'head' : full.startsWith('refs/tags/') ? 'tag' : 'remote';
        const name = full.replace(/^refs\/(heads|tags|remotes)\//, '');
        refs.push({ name, kind, hash: peeled || obj, current: head === '*', upstream: upstream ?? '' });
      }
      const stashes = stashText.split('\n').filter(Boolean).map((l) => {
        const [ref, hash, subject] = l.split('\0');
        return { index: Number(/\{(\d+)\}/.exec(ref)?.[1] ?? 0), hash, subject: subject ?? ref };
      });
      return { root: this.git.root, status: parseStatus(statusText), op, refs, stashes } satisfies Overview;
    },

    log: async ({ skip, search, path: file }) => {
      const args = ['--date-order', `--skip=${Math.max(0, Math.floor(skip) || 0)}`, '-n', String(PAGE + 1)];
      const graph = !search && !file;
      if (file) args.push('--follow', '--', file);
      else if (search?.kind === 'hash') {
        if (!/^[0-9a-f]{4,64}$/i.test(search.q)) return { commits: [], rows: null, more: false };
        const hash = (await this.run(['rev-parse', '--verify', '--quiet', `${search.q}^{commit}`]).catch(() => '')).trim();
        if (!hash || skip) return { commits: [], rows: null, more: false };
        args.splice(0, args.length, '-n', '1', hash, '--');
      } else {
        args.push('--exclude=refs/stash', '--all');
        if (search?.kind === 'message') args.push('-i', '--fixed-strings', `--grep=${search.q}`);
        else if (search?.kind === 'author') args.push('-i', '--fixed-strings', `--author=${search.q}`);
        else if (search?.kind === 'path') args.push('--', search.q);
        else args.push('--');
      }
      const all = await this.log(args, PAGE + 1);
      const commits = all.slice(0, PAGE);
      let rows = null;
      if (graph) {
        // A page refetched later reuses its saved lanes; after a refresh cleared them, a deep page
        // rebuilds them from the hashes and parents of every commit above it (cheap: rev-list only)
        let saved = this.lanes.get(skip);
        if (!saved && skip > 0) {
          const above = (await this.run(['rev-list', '--date-order', '--exclude=refs/stash', '--all', '--parents', `--max-count=${skip}`]))
            .split('\n').filter(Boolean).map((l) => { const [hash, ...parents] = l.split(' '); return { hash, parents }; });
          saved = [];
          layout(above, saved);
        }
        const lanes = [...(saved ?? [])];
        rows = layout(commits, lanes);
        this.lanes.set(skip + commits.length, [...lanes]);
      }
      return { commits, rows, more: all.length > PAGE };
    },

    commitFiles: async ({ hash }) => {
      const base = await this.base(hash);
      const [numstat, body] = await Promise.all([
        this.run(['diff', '--numstat', '-z', '-M', base, arg(hash), '--']),
        this.run(['show', '-s', '--format=%B', arg(hash), '--']),
      ]);
      const t = numstat.split('\0');
      const files: ChangedFile[] = [];
      for (let i = 0; i < t.length; i++) {
        if (!t[i]) continue;
        const [a, d, p] = t[i].split('\t');
        const f: ChangedFile = { path: p, added: Number(a) || 0, deleted: Number(d) || 0, binary: a === '-' };
        // Renames: the path field is empty and the old and new paths follow as their own tokens
        if (!p) { f.orig = t[++i]; f.path = t[++i]; }
        files.push(f);
      }
      return { files, body: body.trim() };
    },

    commitDiff: async ({ hash, path: file, orig }) =>
      this.diff(['diff', '-M', await this.base(hash), arg(hash), '--', ...(orig ? [orig] : []), file]),

    workDiff: async ({ path: file, staged, untracked }) =>
      this.diff(untracked
        ? ['diff', '--no-index', '--', '/dev/null', file]
        : ['diff', ...(staged ? ['--cached'] : []), '--', file]),

    openDiff: async ({ hash, path: file, orig, staged }) => {
      const name = path.basename(file);
      if (hash) {
        const base = await this.base(hash);
        await vscode.commands.executeCommand('vscode.diff',
          this.gitUri(orig ?? file, base), this.gitUri(file, hash), `${name} (${hash.slice(0, 7)})`);
      } else if (staged) {
        await vscode.commands.executeCommand('vscode.diff',
          this.gitUri(file, 'HEAD'), this.gitUri(file, ''), `${name} (Index)`);
      } else {
        await vscode.commands.executeCommand('vscode.diff',
          this.gitUri(file, '~'), vscode.Uri.file(path.join(this.git.root, file)), `${name} (Working Tree)`);
      }
    },

    openFile: async ({ path: file, conflict }) => {
      const uri = vscode.Uri.file(path.join(this.git.root, file));
      if (conflict) {
        try {
          await vscode.commands.executeCommand('git.openMergeEditor', uri);
          return;
        } catch {
          // Built-in Git extension disabled: the plain editor still shows the conflict markers
        }
      }
      await vscode.commands.executeCommand('vscode.open', uri);
    },

    stage: async ({ paths }) => { await this.run(['add', '-A', '--', ...paths]); },

    unstage: async ({ paths }) => {
      const born = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
      await this.run(born ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-r', '-q', '--', ...paths]);
    },

    discard: async ({ paths, untracked }) => {
      if (paths.length) await this.run(['restore', '--worktree', '--', ...paths]);
      if (untracked.length) await this.run(['clean', '-f', '-d', '-q', '--', ...untracked]);
    },

    stageLines: async ({ path: file, staged, discard, hunk, lines, texts }) => {
      const [f] = parseDiff(await this.run(['diff', ...(staged ? ['--cached'] : []), '--', file]));
      const h = f?.hunks.find((x) => x.header === hunk);
      // The header alone can match a hunk whose lines changed: the selected lines must still be what was shown
      const same = h && lines.length > 0 && lines.length === texts.length && lines.every((i, k) => h.lines[i] === texts[k]);
      if (!f || !h || !same) throw new GitError('The file changed since it was shown. Refresh and try again.');
      const pick = new Set(lines);
      // Unstage and discard apply in reverse: to the index, or to the working tree
      const patch = partialPatch(f, h, pick, staged || !!discard);
      if (!patch) return;
      const flags = staged ? ['--cached', '--reverse'] : discard ? ['--reverse'] : ['--cached'];
      await this.run(['apply', '--recount', '--whitespace=nowarn', ...flags, '-'], { input: patch });
    },

    commit: async ({ message, amend, signoff }) => {
      if (!message.trim()) throw new GitError('Write a commit message first.');
      await this.run(['commit', '-F', '-', ...(amend ? ['--amend'] : []), ...(signoff ? ['--signoff'] : [])], { input: message });
    },

    lastMessage: async () => (await this.run(['log', '-1', '--format=%B'])).trim(),

    checkout: async ({ ref }) => {
      const exists = (r: string) => this.run(['show-ref', '--verify', '--quiet', r]).then(() => true, () => false);
      if (await exists(`refs/heads/${arg(ref)}`)) return void (await this.run(['switch', ref]));
      if (await exists(`refs/remotes/${ref}`)) {
        const local = ref.slice(ref.indexOf('/') + 1);
        await this.run(await exists(`refs/heads/${local}`) ? ['switch', local] : ['switch', '--track', ref]);
        return;
      }
      await this.run(['switch', '--detach', ref]);
    },

    branchCreate: async ({ name, at, checkout }) => {
      await this.run(['check-ref-format', '--branch', arg(name)]);
      await this.run(checkout ? ['switch', '-c', name, arg(at)] : ['branch', name, arg(at)]);
    },

    branchRename: async ({ from, to }) => {
      await this.run(['check-ref-format', '--branch', arg(to)]);
      await this.run(['branch', '-m', arg(from), to]);
    },

    branchDelete: async ({ name, force, remote }) => {
      if (remote) {
        const i = arg(name).indexOf('/');
        await this.run(['push', name.slice(0, i), '--delete', name.slice(i + 1)], { network: true });
      } else {
        await this.run(['branch', force ? '-D' : '-d', arg(name)]);
      }
    },

    merge: async ({ ref }) => { await this.run(['merge', '--no-edit', arg(ref)]); },
    rebaseOnto: async ({ ref }) => { await this.run(['rebase', arg(ref)]); },

    rebaseTodo: async ({ base }) => this.log(['--reverse', '--no-merges', `${arg(base)}..HEAD`, '--'], 1000),

    rebaseInteractive: async ({ base, steps }) => {
      const { todo, messages } = rebasePlan(steps);
      await this.run(['-c', 'rebase.autoSquash=false', 'rebase', '-i', arg(base)], { todo, messages });
    },

    cherryPick: async ({ hash }) => {
      const merge = (await this.parents(hash)).length > 1;
      await this.run(['cherry-pick', ...(merge ? ['-m', '1'] : []), arg(hash)]);
    },

    revert: async ({ hash }) => {
      const merge = (await this.parents(hash)).length > 1;
      await this.run(['revert', '--no-edit', ...(merge ? ['-m', '1'] : []), arg(hash)]);
    },

    reset: async ({ hash, mode }) => {
      if (!['soft', 'mixed', 'hard'].includes(mode)) throw new GitError('Invalid reset mode');
      await this.run(['reset', `--${mode}`, arg(hash), '--']);
    },

    tagCreate: async ({ name, at, message }) => {
      await this.run(['check-ref-format', `refs/tags/${arg(name)}`]);
      await this.run(message.trim() ? ['tag', '-a', name, '-m', message, arg(at)] : ['tag', name, arg(at)]);
    },
    tagDelete: async ({ name }) => { await this.run(['tag', '-d', arg(name)]); },

    stashSave: async ({ message, untracked }) => {
      await this.run(['stash', 'push', ...(untracked ? ['-u'] : []), ...(message.trim() ? ['-m', message] : [])]);
    },
    stashApply: async ({ hash, pop }) => { await this.run(['stash', pop ? 'pop' : 'apply', await this.stashRef(hash)]); },
    stashDrop: async ({ hash }) => { await this.run(['stash', 'drop', await this.stashRef(hash)]); },

    fetch: async () => { await this.run(['fetch', '--all', '--prune'], { network: true }); },
    pull: async () => { await this.run(['pull', '--no-edit'], { network: true }); },
    push: async ({ force }) => {
      const status = parseStatus(await this.run(['status', '--porcelain=v2', '--branch', '-z']));
      if (!status.branch) throw new GitError('Check out a branch before pushing (HEAD is detached).');
      const lease = force ? ['--force-with-lease'] : []; // never a plain --force
      await this.run(status.upstream ? ['push', ...lease] : ['push', ...lease, '-u', await this.defaultRemote(), 'HEAD'],
        { network: true });
    },

    continueOp: async ({ message }) => {
      const op = await this.op();
      if (!op) return;
      // GIT_EDITOR supplies the message (or keeps git's default), so --continue never hangs
      await this.run([op, '--continue'], { messages: message?.trim() ? [message] : [] });
    },
    abortOp: async () => {
      const op = await this.op();
      if (op) await this.run([op, '--abort']);
    },

    blame: async ({ path: file }) => {
      const meta = new Map<string, { author: string; time: number; summary: string }>();
      const out: BlameLine[] = [];
      let rest = '', hash = '';
      const take = (line: string) => {
        if (line.startsWith('\t')) {
          const m = meta.get(hash) ?? { author: '', time: 0, summary: '' };
          out.push({ hash, ...m, text: line.slice(1) });
          return;
        }
        const head = /^([0-9a-f]{40,64}) \d+ \d+/.exec(line);
        if (head) {
          hash = head[1];
          if (!meta.has(hash)) meta.set(hash, { author: '', time: 0, summary: '' });
          return;
        }
        const m = meta.get(hash);
        if (!m) return;
        if (line.startsWith('author ')) m.author = line.slice(7);
        else if (line.startsWith('author-time ')) m.time = Number(line.slice(12));
        else if (line.startsWith('summary ')) m.summary = line.slice(8);
      };
      await this.git.stream(['blame', '--porcelain', '--', file], (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop()!;
        lines.forEach(take);
        if (out.length >= MAX_BLAME_LINES) return false;
      });
      if (rest) take(rest);
      return out;
    },

    copy: async ({ text }) => { await vscode.env.clipboard.writeText(String(text)); },
  };
}
