import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogParser } from '../.test-out/log.mjs';

const rec = (...f) => f.map((x) => x + '\0').join('');

test('7-field records, including empty %D and an empty %P (root commit)', () => {
  const text =
    rec('aaa', 'bbb ccc', 'Ann', 'ann@x', '1700000000', 'HEAD -> main, tag: v1', 'Merge feature') +
    rec('ccc', '', 'Bob', 'bob@x', '1690000000', '', 'Initial commit');
  const commits = new LogParser().push(text);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    hash: 'aaa', parents: ['bbb', 'ccc'], author: 'Ann', email: 'ann@x', time: 1700000000,
    refs: ['HEAD -> main', 'tag: v1'], subject: 'Merge feature',
  });
  assert.deepEqual(commits[1].parents, []);
  assert.deepEqual(commits[1].refs, []);
});

test('records split across chunks at any byte', () => {
  const text = rec('aaa', 'bbb', 'A', 'a@x', '1', '', 'one') + rec('bbb', '', 'B', 'b@x', '2', '', 'two, with: punctuation');
  for (let cut = 0; cut <= text.length; cut++) {
    const p = new LogParser();
    const got = [...p.push(text.slice(0, cut)), ...p.push(text.slice(cut))];
    assert.deepEqual(got.map((c) => c.subject), ['one', 'two, with: punctuation'], `cut at ${cut}`);
  }
});

test('an unfinished record is held back until its last field arrives', () => {
  const p = new LogParser();
  assert.equal(p.push('aaa\0bbb\0A\0a@x\0').length, 0);
  assert.equal(p.push('1\0\0subject\0').length, 1);
});
