// Runs git. Always an argument array through spawn (never a shell string), so repository content
// can't inject commands. Every call has a timeout, and every child is killed on dispose.
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

const LOCAL_TIMEOUT = 30_000;
const NETWORK_TIMEOUT = 120_000;

export class GitError extends Error {
  constructor(message: string, readonly code: number | null = null) {
    super(message);
  }
}

export class TooLarge extends GitError {
  constructor() {
    super('Output too large');
  }
}

export interface RunOptions {
  /** Written to stdin */
  input?: string;
  /** fetch / pull / push: longer timeout */
  network?: boolean;
  /** Stop and throw TooLarge past this many bytes of stdout */
  maxBytes?: number;
  /** Texts handed out, in order, each time git opens GIT_EDITOR (reword, squash, continue); null keeps git's default */
  messages?: (string | null)[];
  /** Exit codes that count as success besides 0 (diff --no-index exits 1 when files differ) */
  okCodes?: number[];
  /** Replaces the rebase todo list when git opens GIT_SEQUENCE_EDITOR */
  todo?: string;
}

/** Shell-quoted for the GIT_EDITOR command line, which git itself runs through sh */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class Git {
  private children = new Set<ChildProcess>();

  private constructor(
    readonly root: string,
    readonly gitDir: string,
    private readonly editorScript: string
  ) {}

  /** The repository containing `cwd`, or null when there is none */
  static async open(cwd: string, editorScript: string): Promise<Git | null> {
    const probe = new Git(cwd, '', editorScript);
    try {
      // Never assume <root>/.git: in a worktree or submodule .git is a file
      const [root, gitDir] = (await probe.run(['rev-parse', '--show-toplevel', '--absolute-git-dir'])).split('\n');
      return root && gitDir ? new Git(root, gitDir, editorScript) : null;
    } catch {
      return null;
    } finally {
      probe.dispose();
    }
  }

  run(args: string[], o: RunOptions = {}): Promise<string> {
    let out = '';
    return this.stream(args, (chunk) => { out += chunk; }, o).then(() => out);
  }

  /** Spawn git and hand stdout to `onData` as it arrives. Return false from onData to stop early. */
  stream(args: string[], onData: (chunk: string) => void | false, o: RunOptions = {}): Promise<void> {
    let tmp: string | null = null;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0', // no terminal: a credential prompt fails instead of hanging
      GIT_ASKPASS: '', SSH_ASKPASS: '', // VS Code's own askpass needs its IPC; don't inherit it
      LC_ALL: 'C', // parsers expect untranslated output
      GIT_OPTIONAL_LOCKS: '0', // status/log must not fight the user's own git for index.lock
      GIT_LITERAL_PATHSPECS: '1', // a file named "[id].tsx" must not also match "i.tsx"
    };
    if (o.messages || o.todo !== undefined) {
      tmp = mkdtempSync(path.join(tmpdir(), 'darkmark-git-'));
      const editor = (queue: (string | null)[]) => {
        const file = path.join(tmp!, `${Math.random().toString(36).slice(2)}.json`);
        writeFileSync(file, JSON.stringify(queue));
        return `ELECTRON_RUN_AS_NODE=1 ${sq(process.execPath)} ${sq(this.editorScript)} ${sq(file)}`;
      };
      env.GIT_EDITOR = editor(o.messages ?? []);
      if (o.todo !== undefined) env.GIT_SEQUENCE_EDITOR = editor([o.todo]);
    } else {
      // Nothing to supply: keep git's default message rather than open an editor
      env.GIT_EDITOR = ':';
    }

    return spawnStream('git', args, this.root, env, onData, o, this.children)
      .finally(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });
  }

  dispose(): void {
    for (const c of this.children) c.kill();
    this.children.clear();
  }
}

/**
 * Spawn `bin` with an argument array (never a shell) and hand stdout to `onData` as it arrives.
 * Return false from onData to stop early. Timeout, size cap and error text per RunOptions.
 */
export function spawnStream(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  onData: (chunk: string) => void | false, o: RunOptions, children: Set<ChildProcess>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, windowsHide: true });
    children.add(child);
    // tail: end of stdout, for the error message when git reports there (merge prints CONFLICT to stdout)
    let err = '', tail = '', bytes = 0, stopped = false;
    const cleanup = () => {
      clearTimeout(timer);
      children.delete(child);
    };
    const stop = (e?: Error) => {
      if (stopped) return;
      stopped = true;
      child.kill();
      cleanup();
      e ? reject(e) : resolve();
    };
    const timer = setTimeout(() => stop(new GitError(`${bin} ${args[0]} timed out`)),
      o.network ? NETWORK_TIMEOUT : LOCAL_TIMEOUT);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      bytes += Buffer.byteLength(chunk);
      if (o.maxBytes && bytes > o.maxBytes) return stop(new TooLarge());
      tail = (tail + chunk).slice(-2000);
      if (onData(chunk) === false) stop();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (err.length < 64_000) err += chunk; });
    child.on('error', (e) => stop(new GitError(`Could not run ${bin}: ${e.message}`)));
    child.on('close', (code) => {
      if (stopped) return;
      stopped = true;
      cleanup();
      if (code === 0 || (code !== null && o.okCodes?.includes(code))) resolve();
      else reject(new GitError(err.trim() || tail.trim() || `${bin} ${args[0]} failed (exit ${code})`, code));
    });
    // git may exit before reading all its input (EPIPE); the exit code reports the real outcome
    child.stdin.on('error', () => {});
    if (o.input !== undefined) child.stdin.end(o.input);
    else child.stdin.end();
  });
}
