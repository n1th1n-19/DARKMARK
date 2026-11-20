// The git runner against real repositories: the paths that would hang without GIT_EDITOR,
// GIT_SEQUENCE_EDITOR and GIT_TERMINAL_PROMPT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Git } from '../.test-out/gitrun.mjs';
import { rebasePlan } from '../.test-out/rebase.mjs';

const EDITOR = resolve('.test-out/git-editor.mjs');
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function repo(commits) {
  const dir = mkdtempSync(join(tmpdir(), 'dm-git-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 't');
  for (const [file, text, msg] of commits) {
    writeFileSync(join(dir, file), text);
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-qm', msg);
  }
  return { dir, git: await Git.open(dir, EDITOR) };
}

test('rebasePlan: one message per reword and per squash chain, in editor order', () => {
  const p = rebasePlan([
    { hash: 'aaaa', action: 'pick' },
    { hash: 'bbbb', action: 'squash', message: 'A+B' },
    { hash: 'cccc', action: 'fixup' },
    { hash: 'dddd', action: 'reword', message: 'D!' },
    { hash: 'eeee', action: 'drop' },
    { hash: 'ffff', action: 'pick' },
    { hash: '1111', action: 'fixup' },
  ]);
  assert.equal(p.todo, 'pick aaaa\nsquash bbbb\nfixup cccc\nreword dddd\ndrop eeee\npick ffff\nfixup 1111\n');
  assert.deepEqual(p.messages, ['A+B', 'D!']);
  assert.throws(() => rebasePlan([{ hash: 'aaaa', action: 'squash' }]), /first commit/);
  assert.throws(() => rebasePlan([{ hash: '-x', action: 'pick' }]), /Invalid/);
});

test('repository paths come from git, and a non-repo gives null', async () => {
  const { dir, git } = await repo([['a', '1', 'one']]);
  try {
    assert.ok(git.gitDir.endsWith('.git'));
    const none = mkdtempSync(join(tmpdir(), 'dm-none-'));
    assert.equal(await Git.open(none, EDITOR), null);
    rmSync(none, { recursive: true });
  } finally {
    git.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interactive rebase with squash and reword finishes without an editor', async () => {
  const { dir, git } = await repo([['a', '1', 'base'], ['b', '1', 'two'], ['c', '1', 'three'], ['d', '1', 'four']]);
  try {
    const base = sh(dir, 'rev-parse', 'HEAD~3');
    const [two, three, four] = sh(dir, 'rev-list', '--reverse', `${base}..HEAD`).split('\n');
    const plan = rebasePlan([
      { hash: two, action: 'pick' },
      { hash: three, action: 'squash', message: 'two and three' },
      { hash: four, action: 'reword', message: 'four, reworded' },
    ]);
    await git.run(['-c', 'rebase.autoSquash=false', 'rebase', '-i', base], plan);
    assert.equal(sh(dir, 'log', '--format=%s', `${base}..HEAD`), 'four, reworded\ntwo and three');
    assert.equal(sh(dir, 'status', '--porcelain'), '');
  } finally {
    git.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a conflicting merge continues with the default message, and abort restores', async () => {
  const { dir, git } = await repo([['f', 'base\n', 'base']]);
  try {
    sh(dir, 'switch', '-qc', 'side');
    writeFileSync(join(dir, 'f'), 'side\n');
    sh(dir, 'commit', '-qam', 'side');
    sh(dir, 'switch', '-q', 'main');
    writeFileSync(join(dir, 'f'), 'main\n');
    sh(dir, 'commit', '-qam', 'main');

    await assert.rejects(git.run(['merge', '--no-edit', 'side']), /conflict/i);
    await git.run(['merge', '--abort']);
    assert.equal(sh(dir, 'rev-parse', 'HEAD'), sh(dir, 'rev-parse', 'main'));

    await assert.rejects(git.run(['merge', '--no-edit', 'side']));
    writeFileSync(join(dir, 'f'), 'resolved\n');
    await git.run(['add', 'f']);
    await git.run(['merge', '--continue'], { messages: [] }); // empty queue keeps "Merge branch 'side'"
    assert.match(sh(dir, 'log', '-1', '--format=%s'), /^Merge branch 'side'/);
  } finally {
    git.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push to a remote that wants credentials fails fast instead of prompting', async () => {
  const { dir, git } = await repo([['a', '1', 'one']]);
  try {
    // A local port with nothing listening: fails at once; GIT_TERMINAL_PROMPT=0 covers real auth prompts
    sh(dir, 'remote', 'add', 'origin', 'http://127.0.0.1:9/nobody.git');
    const t = Date.now();
    await assert.rejects(git.run(['push', '-u', 'origin', 'HEAD'], { network: true }));
    assert.ok(Date.now() - t < 20_000);
  } finally {
    git.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('large output stops at maxBytes', async () => {
  const { dir, git } = await repo([['big', 'x\n'.repeat(400_000), 'big']]);
  try {
    await assert.rejects(git.run(['show', 'HEAD'], { maxBytes: 512 * 1024 }), /too large/i);
  } finally {
    git.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paths are literal: discarding "[id].tsx" leaves "i.tsx" alone', async () => {
  const { dir, git } = await repo([['[id].tsx', 'a\n', 'one'], ['i.tsx', 'b\n', 'two']]);
  try {
    writeFileSync(join(dir, '[id].tsx'), 'A\n');
    writeFileSync(join(dir, 'i.tsx'), 'B\n');
    await git.run(['restore', '--worktree', '--', '[id].tsx']);
    assert.equal(sh(dir, 'status', '--porcelain'), 'M i.tsx');
    // A literal "*.tsx" names no file, so nothing gets staged
    await assert.rejects(git.run(['add', '-A', '--', '*.tsx']), /did not match any files/);
    assert.equal(sh(dir, 'diff', '--cached', '--name-only'), '');
  } finally {
    git.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stdin is not written to a git that already exited (no uncaught EPIPE)', async () => {
  const { dir, git } = await repo([['a', '1', 'one']]);
  try {
    // `git version` never reads stdin; a large input must not crash the process
    await git.run(['version'], { input: 'x'.repeat(4 * 1024 * 1024) });
  } finally {
    git.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
