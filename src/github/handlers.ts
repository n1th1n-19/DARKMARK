// GitHub requests for the Git panel's GitHub tab. Everything goes through gh with --json.
import MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import { parseDiff } from '../git/diff';
import { GitError, TooLarge } from '../git/runner';
import type { GhApi, GhCommit, Label, PrItem, TimelineItem } from '../git/protocol';
import { Gh, LIMIT } from './gh';
import { checkRuns, summarize, type RollupEntry } from './rollup';

const MAX_DIFF_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 5000;
const LOG_LINES = 2000;

// GitHub bodies use raw HTML (<details>, <img>, <sub>), so it is rendered here and then rebuilt
// from an allowlist in the webview (src/webview/lib/sanitize.ts) before it reaches the page
const md = new MarkdownIt({ html: true, linkify: true, breaks: true });
const render = (text: string | null | undefined) => md.render(text ?? '')
  // Task lists, like GitHub: "- [ ] foo" / "- [x] foo" (the preview's engine does the same)
  .replace(/<li>(\s*<p>)?\[([ xX])\]\s/g, (_, p = '', mark) => `<li>${p}<input type="checkbox"${mark === ' ' ? '' : ' checked'}> `);

/** A PR, issue, run or job number from the webview */
const n = (v: unknown): string => {
  const x = Number(v);
  if (!Number.isInteger(x) || x <= 0) throw new GitError(`Invalid number: ${v}`);
  return String(x);
};

type Author = { login: string } | null;
const login = (a: Author) => a?.login ?? 'ghost';
const labels = (ls: { name: string; color: string }[] = []): Label[] =>
  ls.map((l) => ({ name: l.name, color: /^[0-9a-f]{6}$/i.test(l.color) ? l.color : '8b949e' }));

interface RawComment { author: Author; createdAt: string; body: string }
interface RawReview { author: Author; submittedAt: string; body: string; state: string }
interface RawCommit { oid: string; messageHeadline: string; committedDate: string; authors: { login?: string; name?: string }[] }

const commit = (c: RawCommit): GhCommit => ({
  oid: c.oid, headline: c.messageHeadline, date: c.committedDate,
  author: c.authors?.[0]?.login || c.authors?.[0]?.name || 'unknown',
});

function timeline(comments: RawComment[] = [], reviews: RawReview[] = [], commits: RawCommit[] = []): TimelineItem[] {
  return [
    ...comments.map((c): TimelineItem => ({ kind: 'comment', author: login(c.author), date: c.createdAt, bodyHtml: render(c.body) })),
    ...reviews.map((r): TimelineItem => ({ kind: 'review', author: login(r.author), date: r.submittedAt, state: r.state, bodyHtml: r.body ? render(r.body) : '' })),
    ...commits.map((c): TimelineItem => ({ kind: 'commit', author: commit(c).author, date: c.committedDate, commit: commit(c) })),
  ].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

const PR_LIST = 'number,title,author,headRefName,baseRefName,isDraft,state,createdAt,updatedAt,headRefOid,labels,comments,statusCheckRollup,reviewDecision';
const ISSUE_LIST = 'number,title,author,state,labels,createdAt,updatedAt,comments';

export function githubHandlers(gh: Gh, branch: () => Promise<string | null>): { [M in keyof GhApi]: (p: GhApi[M][0]) => Promise<GhApi[M][1]> } {
  let me: string | null = null;

  // Search qualifiers for a filter; GitHub's search API has no @me, so the login is spelled out
  const qualifiers = (filter: string) =>
    filter === 'mine' ? ` author:${me}` : filter === 'review' ? ` review-requested:${me}` : '';
  const count = async (q: string) =>
    Number(await gh.run(['api', `search/issues?per_page=1&q=repo:{owner}/{repo}+${encodeURIComponent(q)}`, '--jq=.total_count']));

  const prItem = (p: Record<string, unknown> & { author: Author; labels: Label[]; comments: unknown[]; statusCheckRollup: RollupEntry[] }) => ({
    number: p.number, title: p.title, author: login(p.author), headRefName: p.headRefName, baseRefName: p.baseRefName,
    isDraft: p.isDraft, state: p.state, createdAt: p.createdAt, updatedAt: p.updatedAt, headRefOid: p.headRefOid,
    labels: labels(p.labels), comments: p.comments?.length ?? 0, checks: summarize(p.statusCheckRollup), reviewDecision: p.reviewDecision ?? '',
  }) as PrItem;

  return {
    ghState: async () => {
      const s = await gh.state();
      if (s.ok) me = s.user;
      return s;
    },

    counts: async ({ kind, filter, search }) => {
      if (filter && filter !== 'open' && !me) { const st = await gh.state(); if (st.ok) me = st.user; }
      const base = `is:${kind}${qualifiers(filter)}${search.trim() ? ` ${search.trim()}` : ''}`;
      const [open, closed] = await Promise.all([count(`${base} is:open`), count(`${base} is:closed`)]);
      return { open, closed };
    },

    prList: async ({ state, filter }) => {
      if (state !== 'open' && state !== 'closed') throw new GitError('Invalid state');
      const extra = filter === 'mine' ? ['--author=@me'] : filter === 'review' ? ['--search=review-requested:@me'] : [];
      const list = await gh.json<never[]>(['pr', 'list', `--state=${state}`, ...extra, `--limit=${LIMIT}`, `--json=${PR_LIST}`]);
      return list.map(prItem);
    },

    prView: async ({ number }) => {
      const p = await gh.json<Record<string, unknown> & {
        author: Author; body: string; comments: RawComment[]; reviews: RawReview[]; commits: RawCommit[];
        labels: Label[]; statusCheckRollup: RollupEntry[]; reviewRequests: { login?: string; name?: string }[];
      }>(['pr', 'view', n(number), `--json=${PR_LIST},body,url,mergeable,additions,deletions,changedFiles,mergedAt,closedAt,reviews,commits,reviewRequests`]);
      // Reviewers: latest review state per person, then requested reviewers who haven't reviewed yet
      const latest = new Map<string, string>();
      for (const r of p.reviews ?? []) if (r.state !== 'COMMENTED' || !latest.has(login(r.author))) latest.set(login(r.author), r.state);
      for (const r of p.reviewRequests ?? []) { const who = r.login || r.name || ''; if (who && !latest.has(who)) latest.set(who, 'PENDING'); }
      return {
        ...prItem(p),
        bodyHtml: render(p.body), url: p.url, mergeable: p.mergeable, additions: p.additions, deletions: p.deletions,
        changedFiles: p.changedFiles, mergedAt: p.mergedAt ?? null, closedAt: p.closedAt ?? null,
        timeline: timeline(p.comments, p.reviews, p.commits),
        commits: (p.commits ?? []).map(commit),
        checkRuns: checkRuns(p.statusCheckRollup),
        reviewers: [...latest].map(([who, state]) => ({ login: who, state })),
      } as never;
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
    prSetState: async ({ number, open }) => { await gh.run(['pr', open ? 'reopen' : 'close', n(number)]); },
    prReady: async ({ number }) => { await gh.run(['pr', 'ready', n(number)]); },

    prMerge: async ({ number, method, deleteBranch }) => {
      if (!['merge', 'squash', 'rebase'].includes(method)) throw new GitError('Invalid merge method');
      await gh.run(['pr', 'merge', n(number), `--${method}`, ...(deleteBranch ? ['--delete-branch'] : [])]);
    },

    prCreate: async ({ title, body, base, draft, labels: ls }) => {
      if (!title.trim()) throw new GitError('Give the pull request a title.');
      const out = await gh.run(['pr', 'create', `--title=${title}`, '--body-file=-',
        ...(base.trim() ? [`--base=${base.trim()}`] : []), ...(draft ? ['--draft'] : []),
        ...ls.filter((l) => l.trim()).map((l) => `--label=${l.trim()}`)], { input: body });
      return out.trim().split('\n').pop() ?? '';
    },

    prHeads: async () => {
      const list = await gh.json<{ headRefOid: string; number: number }[]>(['pr', 'list', '--state=all', `--limit=${LIMIT * 2}`, '--json=headRefOid,number']);
      return Object.fromEntries(list.map((p) => [p.headRefOid, p.number]));
    },

    defaultBase: async () =>
      (await gh.run(['repo', 'view', '--json=defaultBranchRef', '--jq=.defaultBranchRef.name'])).trim(),

    issueList: async ({ state, search }) => {
      if (state !== 'open' && state !== 'closed') throw new GitError('Invalid state');
      const list = await gh.json<(Record<string, unknown> & { author: Author; labels: Label[]; comments: unknown[] })[]>(['issue', 'list', `--state=${state}`,
        ...(search.trim() ? [`--search=${search.trim()}`] : []), `--limit=${LIMIT}`, `--json=${ISSUE_LIST}`]);
      return list.map((i) => ({ ...i, author: login(i.author), labels: labels(i.labels), comments: i.comments?.length ?? 0 })) as never;
    },

    issueView: async ({ number }) => {
      const i = await gh.json<Record<string, unknown> & { author: Author; body: string; comments: RawComment[]; labels: Label[] }>(['issue', 'view', n(number),
        `--json=${ISSUE_LIST},body,url,closedAt`]);
      return {
        ...i, author: login(i.author), labels: labels(i.labels), comments: i.comments?.length ?? 0,
        bodyHtml: render(i.body), closedAt: i.closedAt ?? null, timeline: timeline(i.comments),
      } as never;
    },

    issueComment: async ({ number, body }) => {
      if (!body.trim()) throw new GitError('Write a comment first.');
      await gh.run(['issue', 'comment', n(number), '--body-file=-'], { input: body });
    },

    issueCreate: async ({ title, body, labels: ls }) => {
      if (!title.trim()) throw new GitError('Give the issue a title.');
      const out = await gh.run(['issue', 'create', `--title=${title}`, '--body-file=-',
        ...ls.filter((l) => l.trim()).map((l) => `--label=${l.trim()}`)], { input: body });
      return out.trim().split('\n').pop() ?? '';
    },

    issueSetState: async ({ number, open }) => { await gh.run(['issue', open ? 'reopen' : 'close', n(number)]); },

    runList: async ({ all }) => {
      const b = all ? null : await branch();
      return gh.json(['run', 'list', ...(b ? [`--branch=${b}`] : []), `--limit=${LIMIT}`,
        '--json=databaseId,number,displayTitle,status,conclusion,workflowName,createdAt,updatedAt,event,headBranch,url']);
    },

    runView: async ({ id }) => gh.json(['run', 'view', n(id),
      '--json=databaseId,number,displayTitle,status,conclusion,workflowName,createdAt,updatedAt,event,headBranch,headSha,url,jobs']),

    jobLog: async ({ jobId, step }) => {
      // Lines are "<job>\t<step>\t<timestamp> <text>": keep the step's lines, only the last LOG_LINES
      const lines: string[] = [];
      let rest = '';
      const take = (line: string) => {
        const parts = line.split('\t');
        if (parts.length < 3 || parts[1] !== step) return;
        const text = parts.slice(2).join('\t')
          .replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '')
          .replace(/(\x1b|\^\[)\[[0-9;]*m/g, ''); // color codes, raw or as gh prints them
        if (text === '##[endgroup]') return;
        lines.push(text.replace(/^##\[group\]/, ''));
        if (lines.length > LOG_LINES * 2) lines.splice(0, lines.length - LOG_LINES);
      };
      await gh.stream(['run', 'view', `--job=${n(jobId)}`, '--log'], (chunk) => {
        const parts = (rest + chunk).split('\n');
        rest = parts.pop()!;
        parts.forEach(take);
      });
      if (rest) take(rest);
      return lines.slice(-LOG_LINES).join('\n');
    },

    runRerun: async ({ id, failedOnly }) => { await gh.run(['run', 'rerun', n(id), ...(failedOnly ? ['--failed'] : [])]); },

    ghCommits: async () => {
      const shape = ['--jq=[.[] | {oid: .sha, headline: (.commit.message | split("\\n")[0]), date: .commit.author.date, author: (.author.login // .commit.author.name)}]'];
      const b = await branch();
      // The branch may not be on GitHub yet: fall back to the default branch
      if (b) {
        const list = await gh.json<GhCommit[]>(['api', `repos/{owner}/{repo}/commits?per_page=${LIMIT}&sha=${encodeURIComponent(b)}`, ...shape]).catch(() => null);
        if (list) return { branch: b, commits: list };
      }
      const def = (await gh.run(['repo', 'view', '--json=defaultBranchRef', '--jq=.defaultBranchRef.name'])).trim();
      return { branch: def, commits: await gh.json<GhCommit[]>(['api', `repos/{owner}/{repo}/commits?per_page=${LIMIT}`, ...shape]) };
    },

    openUrl: async ({ url }) => {
      // Document content is untrusted: only hand web/mail links to the OS
      if (!/^(https?|mailto):/i.test(String(url))) throw new GitError('Only web and mail links open');
      await vscode.env.openExternal(vscode.Uri.parse(String(url)));
    },
  };
}
