// Messages between the Git panel webview and the extension host. Types only.
import type { GraphRow } from './graph';
import type { Commit } from './log';
import type { FileDiff } from './diff';
import type { Status } from './status';
import type { GhState } from '../github/gh';
import type { CheckRun } from '../github/rollup';

export type SearchKind = 'message' | 'author' | 'hash' | 'path';
export type Op = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

export interface ChangedFile { path: string; orig?: string; added: number; deleted: number; binary: boolean }
export interface Ref { name: string; kind: 'head' | 'remote' | 'tag'; hash: string; current: boolean; upstream: string }
export interface Stash { index: number; hash: string; subject: string }
export interface BlameLine { hash: string; author: string; time: number; summary: string; text: string }

/** A diff the panel can show inline, or the reason it can't */
export type DiffResult = { kind: 'diff'; file: FileDiff | null } | { kind: 'large' } | { kind: 'binary' };

export interface Overview {
  root: string;
  status: Status;
  op: Op;
  refs: Ref[];
  stashes: Stash[];
}

export interface Label { name: string; color: string }
export type CheckSummary = 'pass' | 'fail' | 'pending' | null;
export interface GhCommit { oid: string; headline: string; author: string; date: string }
export interface TimelineItem {
  kind: 'comment' | 'review' | 'commit'; author: string; date: string;
  bodyHtml?: string; state?: string; commit?: GhCommit;
}
export interface PrItem {
  number: number; title: string; author: string; headRefName: string; baseRefName: string; isDraft: boolean;
  state: string; createdAt: string; updatedAt: string; headRefOid: string; labels: Label[]; comments: number;
  checks: CheckSummary; reviewDecision: string;
}
export interface PrDetail extends PrItem {
  bodyHtml: string; url: string; mergeable: string; additions: number; deletions: number; changedFiles: number;
  mergedAt: string | null; closedAt: string | null; timeline: TimelineItem[]; commits: GhCommit[];
  checkRuns: CheckRun[]; reviewers: { login: string; state: string }[];
}
export interface IssueItem { number: number; title: string; author: string; state: string; labels: Label[]; createdAt: string; updatedAt: string; comments: number }
export interface IssueDetail extends IssueItem { bodyHtml: string; url: string; closedAt: string | null; timeline: TimelineItem[] }
export interface Run {
  databaseId: number; number: number; displayTitle: string; status: string; conclusion: string; workflowName: string;
  createdAt: string; updatedAt: string; event: string; headBranch: string; url: string;
}
export interface Step { number: number; name: string; status: string; conclusion: string; startedAt: string; completedAt: string }
export interface Job { databaseId: number; name: string; status: string; conclusion: string; startedAt: string; completedAt: string; url: string; steps: Step[] }
export interface RunDetail extends Run { headSha: string; jobs: Job[] }
type Filter = 'open' | 'mine' | 'review';

/** GitHub tab requests (src/github/handlers.ts), name -> [params, result] */
export interface GhApi {
  ghState: [{}, GhState];
  /** Open and closed totals for the list header, via GitHub search */
  counts: [{ kind: 'pr' | 'issue'; filter: Filter | ''; search: string }, { open: number; closed: number }];
  prList: [{ state: 'open' | 'closed'; filter: Filter }, PrItem[]];
  prView: [{ number: number }, PrDetail];
  prDiff: [{ number: number }, { kind: 'diff'; files: FileDiff[] } | { kind: 'large' }];
  prComment: [{ number: number; body: string }, void];
  prReview: [{ number: number; action: 'approve' | 'request-changes' | 'comment'; body: string }, void];
  prCheckout: [{ number: number }, void];
  prSetState: [{ number: number; open: boolean }, void];
  prReady: [{ number: number }, void];
  prMerge: [{ number: number; method: 'merge' | 'squash' | 'rebase'; deleteBranch: boolean }, void];
  prCreate: [{ title: string; body: string; base: string; draft: boolean; labels: string[] }, string];
  /** head commit hash -> PR number, for the graph */
  prHeads: [{}, Record<string, number>];
  defaultBase: [{}, string];
  issueList: [{ state: 'open' | 'closed'; search: string }, IssueItem[]];
  issueView: [{ number: number }, IssueDetail];
  issueComment: [{ number: number; body: string }, void];
  issueCreate: [{ title: string; body: string; labels: string[] }, string];
  issueSetState: [{ number: number; open: boolean }, void];
  runList: [{ all: boolean }, Run[]];
  runView: [{ id: number }, RunDetail];
  /** Log lines of one step of one job (last 2,000) */
  jobLog: [{ jobId: number; step: string }, string];
  runRerun: [{ id: number; failedOnly: boolean }, void];
  /** Commits on GitHub for the current branch (or the default branch when it isn't pushed) */
  ghCommits: [{}, { branch: string; commits: GhCommit[] }];
  openUrl: [{ url: string }, void];
}

/** Request name -> [params, result] */
export interface Api extends GhApi {
  overview: [{}, Overview];
  log: [{ skip: number; search?: { kind: SearchKind; q: string }; path?: string }, { commits: Commit[]; rows: GraphRow[] | null; more: boolean }];
  commitFiles: [{ hash: string }, { files: ChangedFile[]; body: string }];
  commitDiff: [{ hash: string; path: string; orig?: string }, DiffResult];
  workDiff: [{ path: string; staged: boolean; untracked: boolean }, DiffResult];
  openDiff: [{ hash?: string; path: string; orig?: string; staged?: boolean }, void];
  openFile: [{ path: string; conflict?: boolean }, void];
  stage: [{ paths: string[] }, void];
  unstage: [{ paths: string[] }, void];
  discard: [{ paths: string[]; untracked: string[] }, void];
  /** Per hunk / per line: hunk is located by its header in a fresh diff, so a stale view fails safely */
  /** lines: indexes into the hunk; texts: those lines as shown, checked against a fresh diff */
  stageLines: [{ path: string; staged: boolean; discard?: boolean; hunk: string; lines: number[]; texts: string[] }, void];
  commit: [{ message: string; amend: boolean; signoff: boolean }, void];
  lastMessage: [{}, string];
  checkout: [{ ref: string }, void];
  branchCreate: [{ name: string; at: string; checkout: boolean }, void];
  branchRename: [{ from: string; to: string }, void];
  branchDelete: [{ name: string; force: boolean; remote: boolean }, void];
  merge: [{ ref: string }, void];
  rebaseOnto: [{ ref: string }, void];
  rebaseTodo: [{ base: string }, Commit[]];
  rebaseInteractive: [{ base: string; steps: { hash: string; action: RebaseAction; message?: string }[] }, void];
  cherryPick: [{ hash: string }, void];
  revert: [{ hash: string }, void];
  reset: [{ hash: string; mode: 'soft' | 'mixed' | 'hard' }, void];
  tagCreate: [{ name: string; at: string; message: string }, void];
  tagDelete: [{ name: string }, void];
  stashSave: [{ message: string; untracked: boolean }, void];
  /** By commit hash: stash@{n} positions shift when another stash is pushed */
  stashApply: [{ hash: string; pop: boolean }, void];
  stashDrop: [{ hash: string }, void];
  fetch: [{}, void];
  pull: [{}, void];
  push: [{ force: boolean }, void];
  continueOp: [{ message?: string }, void];
  abortOp: [{}, void];
  blame: [{ path: string }, BlameLine[]];
  copy: [{ text: string }, void];
}

export type Method = keyof Api;
export interface Request<M extends Method = Method> { id: number; method: M; params: Api[M][0] }
export type Response = { id: number; result?: unknown; error?: string };
/** Host -> webview, unasked */
export type Event =
  | { event: 'refresh' }
  | { event: 'show'; view: 'graph' | 'changes' | 'history' | 'blame'; path?: string };
