import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../.test-out/graph.mjs';

// Newest first, like `git log --date-order`
//   M  merge of F into main
//   |\
//   C | main
//   | F feature
//   |/
//   B
//   A  root
const fixture = [
  { hash: 'M', parents: ['C', 'F'] },
  { hash: 'C', parents: ['B'] },
  { hash: 'F', parents: ['B'] },
  { hash: 'B', parents: ['A'] },
  { hash: 'A', parents: [] },
];

test('merge opens a second lane that closes at the fork point', () => {
  const rows = layout(fixture, []);
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 1, 0, 0]);
  assert.deepEqual(rows[0], { col: 0, through: [], into: [], out: [0, 1] });
  assert.deepEqual(rows[1], { col: 0, through: [1], into: [0], out: [0] });
  // F's lane joins B, already awaited on lane 0
  assert.deepEqual(rows[2], { col: 1, through: [0], into: [1], out: [0] });
  assert.deepEqual(rows[3], { col: 0, through: [], into: [0], out: [0] });
  assert.deepEqual(rows[4], { col: 0, through: [], into: [0], out: [] });
});

test('two branch tips get their own lanes, and a freed lane is reused', () => {
  const rows = layout([
    { hash: 'X', parents: ['B'] },
    { hash: 'Y', parents: ['B'] },
    { hash: 'B', parents: ['A'] },
    { hash: 'Z', parents: ['A'] },
    { hash: 'A', parents: [] },
  ], []);
  assert.deepEqual(rows.map((r) => r.col), [0, 1, 0, 1, 0]);
  assert.deepEqual(rows[2].into, [0]); // Y joined lane 0, so lane 1 was freed and Z reuses it
});

test('lane state carries across a page boundary inside a merge', () => {
  // Long feature branch merged into a long main: the open lanes span several pages
  const commits = [{ hash: 'M', parents: ['m0', 'f0'] }];
  for (let i = 0; i < 400; i++) {
    commits.push({ hash: `m${i}`, parents: [`m${i + 1}`] });
    commits.push({ hash: `f${i}`, parents: [i === 399 ? 'base' : `f${i + 1}`] });
  }
  commits.push({ hash: 'm400', parents: ['base'] }, { hash: 'base', parents: [] });

  const whole = layout(commits, []);
  const lanes = [];
  const paged = [];
  for (let i = 0; i < commits.length; i += 300) paged.push(...layout(commits.slice(i, i + 300), lanes));
  assert.deepEqual(paged, whole);
  // At row 300 (first row of page 2) both lanes are still open
  assert.equal(whole[300].through.length, 1);
});
