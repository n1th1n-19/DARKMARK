// Runs the GitHub CLI. Same process rules as git (argument arrays, timeouts, size caps, killed on
// dispose). gh holds the credentials; the extension never sees a token.
import type { ChildProcess } from 'child_process';
import { GitError, spawnStream, type RunOptions } from '../git/runner';

export const LIMIT = 50;

export type GhState = { ok: true; user: string } | { ok: false; reason: 'missing' | 'logged-out'; message: string };

export class Gh {
  private children = new Set<ChildProcess>();

  constructor(private readonly cwd: string) {}

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GH_PROMPT_DISABLED: '1', // no terminal: fail instead of asking
      GH_PAGER: 'cat', PAGER: 'cat',
      NO_COLOR: '1', CLICOLOR: '0',
      GH_NO_UPDATE_NOTIFIER: '1',
      GIT_TERMINAL_PROMPT: '0', // gh pr checkout runs git
    };
  }

  stream(args: string[], onData: (chunk: string) => void | false, o: RunOptions = {}): Promise<void> {
    return spawnStream('gh', args, this.cwd, this.env(), onData, { network: true, ...o }, this.children);
  }

  async run(args: string[], o: RunOptions = {}): Promise<string> {
    let out = '';
    await this.stream(args, (c) => { out += c; }, o);
    return out;
  }

  async json<T>(args: string[], o: RunOptions = {}): Promise<T> {
    const text = await this.run(args, o);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GitError(`gh returned unexpected output: ${text.slice(0, 200)}`);
    }
  }

  /** Installed and logged in? Never throws. */
  async state(): Promise<GhState> {
    try {
      const user = await this.run(['api', 'user', '--jq', '.login'], { network: true });
      return { ok: true, user: user.trim() };
    } catch (e) {
      const msg = (e as Error).message;
      if (/ENOENT|Could not run gh/.test(msg)) {
        return { ok: false, reason: 'missing', message: 'The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then run: gh auth login' };
      }
      if (/auth login|not logged|authentication|HTTP 401/i.test(msg)) {
        return { ok: false, reason: 'logged-out', message: 'gh is not logged in. Run this in a terminal: gh auth login' };
      }
      return { ok: false, reason: 'logged-out', message: msg };
    }
  }

  dispose(): void {
    for (const c of this.children) c.kill();
    this.children.clear();
  }
}
