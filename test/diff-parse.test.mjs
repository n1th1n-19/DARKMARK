import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allChanges, parseDiff, partialPatch } from '../.test-out/diff.mjs';
import { parseStatus } from '../.test-out/status.mjs';

const SAMPLE = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,4 @@ intro
 one
-two
+TWO
 three
 four
@@ -10,2 +10,3 @@
 ten
+ten-and-a-half
 eleven
\\ No newline at end of file
`;

test('hunk parsing', () => {
  const [f] = parseDiff(SAMPLE);
  assert.equal(f.binary, false);
  assert.equal(f.header.length, 4);
  assert.equal(f.hunks.length, 2);
  assert.equal(f.hunks[0].oldStart, 1);
  assert.equal(f.hunks[0].newStart, 1);
  assert.deepEqual(f.hunks[0].lines, [' one', '-two', '+TWO', ' three', ' four']);
  assert.equal(f.hunks[1].lines.at(-1), '\\ No newline at end of file');
});

test('binary files are flagged', () => {
  const [f] = parseDiff('diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n');
  assert.equal(f.binary, true);
  assert.equal(f.hunks.length, 0);
});

test('nothing selected gives no patch; everything selected keeps the hunk', () => {
  const [f] = parseDiff(SAMPLE);
  assert.equal(partialPatch(f, f.hunks[0], new Set()), null);
  const p = partialPatch(f, f.hunks[0], allChanges(f.hunks[0]));
  assert.match(p, /@@ -1,4 \+1,4 @@\n one\n-two\n\+TWO\n three\n four\n$/);
  assert.doesNotMatch(p, /^index /m);
});

// Round trip through real git: stage some lines, then check `git diff --cached`
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', input: args.includes('-') ? undefined : '' });
const apply = (cwd, patch, ...flags) => execFileSync('git', ['apply', '--recount', ...flags, '-'], { cwd, input: patch });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'dm-diff-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'f.txt'), 'a\nb\nc\nd\ne\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  writeFileSync(join(dir, 'f.txt'), 'a\nB\nc\nd\nE\nf\n'); // b->B, e->E, +f
  return dir;
}

test('line staging round trip: only the selected change reaches the index', () => {
  const dir = repo();
  try {
    const [f] = parseDiff(git(dir, 'diff'));
    const h = f.hunks[0];
    // Stage only "-b" and "+B"
    const pick = new Set(h.lines.flatMap((l, i) => (l === '-b' || l === '+B' ? [i] : [])));
    apply(dir, partialPatch(f, h, pick), '--cached');
    assert.equal(git(dir, 'show', ':f.txt'), 'a\nB\nc\nd\ne\n');
    // Worktree untouched
    assert.equal(git(dir, 'diff', '--cached', '--numstat'), '1\t1\tf.txt\n');

    // Unstage it again with a reverse patch built from the cached diff
    const [c] = parseDiff(git(dir, 'diff', '--cached'));
    apply(dir, partialPatch(c, c.hunks[0], allChanges(c.hunks[0]), true), '--cached', '--reverse');
    assert.equal(git(dir, 'diff', '--cached'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reverse patch with a partial selection discards only those lines from the worktree', () => {
  const dir = repo();
  try {
    const [f] = parseDiff(git(dir, 'diff'));
    const h = f.hunks[0];
    const pick = new Set(h.lines.flatMap((l, i) => (l === '+f' ? [i] : [])));
    apply(dir, partialPatch(f, h, pick, true), '--reverse');
    assert.equal(git(dir, 'show', 'HEAD:f.txt').length, 10);
    assert.equal(execFileSync('cat', [join(dir, 'f.txt')], { encoding: 'utf8' }), 'a\nB\nc\nd\nE\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('porcelain v2 status: branch, ahead/behind, rename, conflict, untracked, spaces in paths', () => {
  const text = [
    '# branch.oid 0123456789abcdef', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb with space.txt',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt', 'old name.txt',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc clash.txt',
    '? new.txt', '',
  ].join('\0');
  const s = parseStatus(text);
  assert.equal(s.branch, 'main');
  assert.equal(s.upstream, 'origin/main');
  assert.deepEqual([s.ahead, s.behind], [2, 1]);
  assert.deepEqual(s.files.map((f) => [f.path, f.x, f.y, f.conflict, f.untracked, f.orig]), [
    ['with space.txt', '.', 'M', false, false, undefined],
    ['new name.txt', 'R', '.', false, false, 'old name.txt'],
    ['clash.txt', 'U', 'U', true, false, undefined],
    ['new.txt', '?', '?', false, true, undefined],
  ]);
});

test('detached HEAD and an empty repository', () => {
  const s = parseStatus('# branch.oid (initial)\0# branch.head (detached)\0');
  assert.equal(s.oid, null);
  assert.equal(s.branch, null);
});
