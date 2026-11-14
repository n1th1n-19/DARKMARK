// Run after `npm run build`: the files the extension loads by URL must exist in out/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

test('bundles and copied runtime files exist', () => {
  for (const f of [
    'out/extension.js',
    'out/katex/katex.min.css',
    'out/pdfjs/pdf.worker.min.mjs',
    'out/pdfjs/cmaps',
    'out/pdfjs/standard_fonts',
  ]) assert.ok(existsSync(f), `${f} missing`);
});

test('every viewer registered in extension.ts has a bundle and a manifest entry', () => {
  const src = readFileSync('src/extension.ts', 'utf8');
  const viewers = [...src.matchAll(/viewType: '([^']+)', script: '([^']+)'/g)];
  assert.ok(viewers.length > 0);
  const contributed = new Set(pkg.contributes.customEditors.map((e) => e.viewType));
  for (const [, viewType, script] of viewers) {
    assert.ok(contributed.has(viewType), `${viewType} not in package.json`);
    assert.ok(existsSync(`out/webview/${script}.js`), `out/webview/${script}.js missing`);
  }
});

test('extension bundle does not inline the lazily loaded git bundle', () => {
  assert.ok(!readFileSync('out/extension.js', 'utf8').includes('GIT_TERMINAL_PROMPT'));
});
