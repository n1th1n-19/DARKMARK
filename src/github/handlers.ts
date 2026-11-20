// GitHub requests for the Git panel's GitHub tab. Everything goes through gh with --json.
import MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import { parseDiff } from '../git/diff';
import { GitError, TooLarge } from '../git/runner';
import type { GhApi } from '../git/protocol';
import { Gh, LIMIT } from './gh';

const MAX_DIFF_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 5000;
const LOG_LINES = 2000;

// GitHub text is untrusted: same markdown-it engine as the preview, but raw HTML is escaped,
// and markdown-it already refuses javascript:, vbscript: and file: links
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const render = (text: string | null | undefined) => md.render(text ?? '');

/** A PR or issue number from the webview */
const n = (v: unknown): string => {
  const x = Number(v);
  if (!Number.isInteger(x) || x <= 0) throw new GitError(`Invalid number: ${v}`);
  return String(x);
};

type Author = { login: string } | null;
interface RawComment { author: Author; createdAt: string; body: string }

const PR_FIELDS = 'number,title,author,headRefName,baseRefName,isDraft,state,updatedAt,headRefOid';
const ISSUE_FIELDS = 'number,title,author,state,labels,updatedAt';
const login = (a: Author) => a?.login ?? 'ghost';

export function githubHandlers(gh: Gh, branch: () => Promise<string | null>): { [M in keyof GhApi]: (p: GhApi[M][0]) => Promise<GhApi[M][1]> } {
  const comments = (cs: RawComment[] = []) =>
    cs.map((c) => ({ author: login(c.author), createdAt: c.createdAt, bodyHtml: render(c.body) }));

  return {
    ghState: () => gh.state(),

    prList: async ({ filter }) => {
      const extra = filter === 'mine' ? ['--author=@me'] : filter === 'review' ? ['--search=review-requested:@me'] : [];
      const list = await gh.json<{ author: Author }[]>(['pr', 'list', '--state=open', ...extra, `--limit=${LIMIT}`, `--json=${PR_FIELDS}`]);
      return list.map((p) => ({ ...p, author: login(p.author) })) as never;
    },

    prView: async ({ number }) => {
      const p = await gh.json<Record<string, unknown> & { author: Author; body: string; comments: RawComment[] }>(['pr', 'view', n(number),
        `--json=${PR_FIELDS},body,url,reviewDecision,mergeable,additions,deletions,changedFiles,comments`]);
      const { body, comments: cs, ...rest } = p;
      return { ...rest, author: login(p.author), bodyHtml: render(body), comments: comments(cs) } as never;
    },

    prChecks: async ({ number }) => {
      // Exit 8 = checks pending, 1 = some failed (or none reported): the JSON is still on stdout
      const text = await gh.run(['pr', 'checks', n(number), '--json=name,state,link,workflow,bucket'], { okCodes: [1, 8] });
      return text.trim() ? JSON.parse(text) : [];
    },

    prDiff: async ({ number }) => {
      let text: string;
      try {
        text = await gh.run(['pr', 'diff', n(number), '--color=never'], { maxBytes: MAX_DIFF_BYTES });
      } catch (e) {
        if (e instanceof TooLarge) return { kind: 'large' };
        throw e;
      }
      const files = parseDiff(text);
      const lines = files.reduce((s, f) => s + f.hunks.reduce((t, h) => t + h.lines.length, 0), 0);
      return lines > MAX_DIFF_LINES ? { kind: 'large' } : { kind: 'diff', files };
    },

    prComment: async ({ number, body }) => {
      if (!body.trim()) throw new GitError('Write a comment first.');
      await gh.run(['pr', 'comment', n(number), '--body-file=-'], { input: body });
    },

    prReview: async ({ number, action, body }) => {
      const flag = { approve: '--approve', 'request-changes': '--request-changes', comment: '--comment' }[action];
      if (!flag) throw new GitError('Invalid review action');
      if (action !== 'approve' && !body.trim()) throw new GitError('This review needs a comment.');
      await gh.run(['pr', 'review', n(number), flag, '--body-file=-'], { input: body });
    },

    prCheckout: async ({ number }) => { await gh.run(['pr', 'checkout', n(number)]); },
    prClose: async ({ number }) => { await gh.run(['pr', 'close', n(number)]); },

    prMerge: async ({ number, method, deleteBranch }) => {
      if (!['merge', 'squash', 'rebase'].includes(method)) throw new GitError('Invalid merge method');
      await gh.run(['pr', 'merge', n(number), `--${method}`, ...(deleteBranch ? ['--delete-branch'] : [])]);
    },

    prCreate: async ({ title, body, base, draft, labels }) => {
      if (!title.trim()) throw new GitError('Give the pull request a title.');
      const out = await gh.run(['pr', 'create', `--title=${title}`, '--body-file=-',
        ...(base.trim() ? [`--base=${base.trim()}`] : []), ...(draft ? ['--draft'] : []),
        ...labels.filter((l) => l.trim()).map((l) => `--label=${l.trim()}`)], { input: body });
      return out.trim().split('\n').pop() ?? '';
    },

    prHeads: async () => {
      const list = await gh.json<{ headRefOid: string; number: number }[]>(['pr', 'list', '--state=all', `--limit=${LIMIT * 2}`, '--json=headRefOid,number']);
      return Object.fromEntries(list.map((p) => [p.headRefOid, p.number]));
    },

    defaultBase: async () =>
      (await gh.run(['repo', 'view', '--json=defaultBranchRef', '--jq=.defaultBranchRef.name'])).trim(),

    issueList: async ({ state, search }) => {
      if (!['open', 'closed', 'all'].includes(state)) throw new GitError('Invalid state');
      const list = await gh.json<{ author: Author }[]>(['issue', 'list', `--state=${state}`,
        ...(search.trim() ? [`--search=${search.trim()}`] : []), `--limit=${LIMIT}`, `--json=${ISSUE_FIELDS}`]);
      return list.map((i) => ({ ...i, author: login(i.author) })) as never;
    },

    issueView: async ({ number }) => {
      const i = await gh.json<Record<string, unknown> & { author: Author; body: string; comments: RawComment[] }>(['issue', 'view', n(number),
        `--json=${ISSUE_FIELDS},body,url,comments`]);
      const { body, comments: cs, ...rest } = i;
      return { ...rest, author: login(i.author), bodyHtml: render(body), comments: comments(cs) } as never;
    },

    issueComment: async ({ number, body }) => {
      if (!body.trim()) throw new GitError('Write a comment first.');
      await gh.run(['issue', 'comment', n(number), '--body-file=-'], { input: body });
    },

    issueCreate: async ({ title, body, labels }) => {
      if (!title.trim()) throw new GitError('Give the issue a title.');
      const out = await gh.run(['issue', 'create', `--title=${title}`, '--body-file=-',
        ...labels.filter((l) => l.trim()).map((l) => `--label=${l.trim()}`)], { input: body });
      return out.trim().split('\n').pop() ?? '';
    },

    issueSetState: async ({ number, open }) => { await gh.run(['issue', open ? 'reopen' : 'close', n(number)]); },

    runList: async () => {
      const b = await branch();
      return gh.json(['run', 'list', ...(b ? [`--branch=${b}`] : []), `--limit=${LIMIT}`,
        '--json=databaseId,displayTitle,status,conclusion,workflowName,createdAt,event,headBranch,url']);
    },

    runLog: async ({ id }) => {
      // Streamed: only the last LOG_LINES lines are kept
      const lines: string[] = [];
      let rest = '';
      await gh.stream(['run', 'view', n(id), '--log-failed'], (chunk) => {
        const parts = (rest + chunk).split('\n');
        rest = parts.pop()!;
        lines.push(...parts);
        if (lines.length > LOG_LINES * 2) lines.splice(0, lines.length - LOG_LINES);
      });
      if (rest) lines.push(rest);
      return lines.slice(-LOG_LINES).join('\n');
    },

    runRerun: async ({ id, failedOnly }) => { await gh.run(['run', 'rerun', n(id), ...(failedOnly ? ['--failed'] : [])]); },

    openUrl: async ({ url }) => {
      // Document content is untrusted: only hand web/mail links to the OS
      if (!/^(https?|mailto):/i.test(String(url))) throw new GitError('Only web and mail links open');
      await vscode.env.openExternal(vscode.Uri.parse(String(url)));
    },
  };
}
