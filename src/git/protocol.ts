// Messages between the Git panel webview and the extension host. Types only.
import type { GraphRow } from './graph';
import type { Commit } from './log';
import type { FileDiff } from './diff';
import type { Status } from './status';
import type { GhState } from '../github/gh';

export type SearchKind = 'message' | 'author' | 'hash' | 'path';
export type Op = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';

export interface ChangedFile { path: string; orig?: string; added: number; deleted: number; binary: boolean }
export interface Ref { name: string; kind: 'head' | 'remote' | 'tag'; hash: string; current: boolean; upstream: string }
export interface Stash { index: number; subject: string }
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

export interface GhComment { author: string; createdAt: string; bodyHtml: string }
export interface PrItem {
  number: number; title: string; author: string; headRefName: string; baseRefName: string;
  isDraft: boolean; state: string; updatedAt: string; headRefOid: string;
}
export interface PrDetail extends PrItem {
  bodyHtml: string; url: string; reviewDecision: string; mergeable: string;
  additions: number; deletions: number; changedFiles: number; comments: GhComment[];
}
export interface Check { name: string; state: string; link: string; workflow: string; bucket: string }
export interface IssueItem { number: number; title: string; author: string; state: string; labels: { name: string }[]; updatedAt: string }
export interface IssueDetail extends IssueItem { bodyHtml: string; url: string; comments: GhComment[] }
export interface Run {
  databaseId: number; displayTitle: string; status: string; conclusion: string; workflowName: string;
  createdAt: string; event: string; headBranch: string; url: string;
}

/** GitHub tab requests (src/github/handlers.ts), name -> [params, result] */
export interface GhApi {
  ghState: [{}, GhState];
  prList: [{ filter: 'open' | 'mine' | 'review' }, PrItem[]];
  prView: [{ number: number }, PrDetail];
  prChecks: [{ number: number }, Check[]];
  prDiff: [{ number: number }, { kind: 'diff'; files: FileDiff[] } | { kind: 'large' }];
  prComment: [{ number: number; body: string }, void];
  prReview: [{ number: number; action: 'approve' | 'request-changes' | 'comment'; body: string }, void];
  prCheckout: [{ number: number }, void];
  prClose: [{ number: number }, void];
  prMerge: [{ number: number; method: 'merge' | 'squash' | 'rebase'; deleteBranch: boolean }, void];
  prCreate: [{ title: string; body: string; base: string; draft: boolean; labels: string[] }, string];
  /** head commit hash -> PR number, for the graph */
  prHeads: [{}, Record<string, number>];
  defaultBase: [{}, string];
  issueList: [{ state: 'open' | 'closed' | 'all'; search: string }, IssueItem[]];
  issueView: [{ number: number }, IssueDetail];
  issueComment: [{ number: number; body: string }, void];
  issueCreate: [{ title: string; body: string; labels: string[] }, string];
  issueSetState: [{ number: number; open: boolean }, void];
  runList: [{}, Run[]];
  runLog: [{ id: number }, string];
  runRerun: [{ id: number; failedOnly: boolean }, void];
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
  stageLines: [{ path: string; staged: boolean; discard?: boolean; hunk: string; lines: number[] }, void];
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
  stashApply: [{ index: number; pop: boolean }, void];
  stashDrop: [{ index: number }, void];
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
