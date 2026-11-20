// Messages between the Git panel webview and the extension host. Types only.
import type { GraphRow } from './graph';
import type { Commit } from './log';
import type { FileDiff } from './diff';
import type { Status } from './status';

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

/** Request name -> [params, result] */
export interface Api {
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
