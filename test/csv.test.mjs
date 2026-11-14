// CSV/TSV parsing for the sheet viewer (bundled from src/webview/lib/csv.ts by `npm test`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDelimited, MAX_ROWS, MAX_COLS } from '../.test-out/csv.mjs';

const EMPTY = 0, TEXT = 1, NUM = 2, DATE = 3, BOOL = 4;

test('quoted fields, escaped quotes, embedded separators and newlines', () => {
  const s = parseDelimited('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\n1,,2024-01-02\n', ',');
  assert.equal(s.rows, 3);
  assert.equal(s.cols, 3);
  assert.deepEqual(s.text[1], ['x, y', 'say "hi"', 'line1\nline2']);
  assert.deepEqual(s.text[2], ['1', '', '2024-01-02']);
  assert.deepEqual([...s.kind.slice(6, 9)], [NUM, EMPTY, DATE]);
  assert.equal(s.cutRows, false);
});

test('tsv, ragged rows, last line without newline, booleans', () => {
  const s = parseDelimited('a\tb\nTRUE\t-1.5e3\tx', '\t');
  assert.equal(s.rows, 2);
  assert.equal(s.cols, 3);
  assert.deepEqual([...s.kind.slice(3, 6)], [BOOL, NUM, TEXT]);
});

test('empty and blank input is an empty sheet', () => {
  assert.equal(parseDelimited('', ',').rows, 0);
  assert.equal(parseDelimited(',,\n,,\n', ',').rows, 0);
});

test('row and column limits', () => {
  const lines = Array.from({ length: MAX_ROWS + 10 }, (_, i) => String(i)).join('\n');
  const s = parseDelimited(lines, ',');
  assert.equal(s.rows, MAX_ROWS + 1);
  assert.equal(s.cutRows, true);
  const exact = parseDelimited(Array.from({ length: MAX_ROWS + 1 }, (_, i) => String(i)).join('\n') + '\n', ',');
  assert.equal(exact.cutRows, false);
  const wide = parseDelimited(Array.from({ length: MAX_COLS + 5 }, () => 'x').join(','), ',');
  assert.equal(wide.cols, MAX_COLS);
  assert.equal(wide.cutCols, true);
});
