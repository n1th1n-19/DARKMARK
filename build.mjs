// Bundles the extension (Node) and every webview viewer (browser) into out/,
// then copies runtime files that are loaded by URL rather than imported.
import { build } from 'esbuild';
import { cpSync, existsSync, readdirSync, rmSync } from 'fs';

const watch = process.argv.includes('--watch');
const common = { bundle: true, minify: !watch, sourcemap: watch, logLevel: 'info' };

rmSync('out', { recursive: true, force: true });

// Node entries: the extension, plus lazily required bundles (src/git/index.ts -> out/git.js)
const nodeEntries = { extension: 'src/extension.ts' };
if (existsSync('src/git/index.ts')) nodeEntries.git = 'src/git/index.ts';

await Promise.all([
  build({
    ...common,
    entryPoints: nodeEntries,
    outdir: 'out',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    // ./git is required at runtime from out/git.js, never bundled into extension.js
    external: ['vscode', './git'],
  }),
  build({
    ...common,
    entryPoints: readdirSync('src/webview')
      .filter((f) => f.endsWith('.ts') && !['common.ts', 'env.d.ts'].includes(f))
      .map((f) => `src/webview/${f}`),
    outdir: 'out/webview',
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
  }),
]);

const copy = (from, to) => cpSync(from, to, { recursive: true });
copy('node_modules/katex/dist/katex.min.css', 'out/katex/katex.min.css');
copy('node_modules/katex/dist/fonts', 'out/katex/fonts');
copy('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'out/pdfjs/pdf.worker.min.mjs');
copy('node_modules/pdfjs-dist/cmaps', 'out/pdfjs/cmaps');
copy('node_modules/pdfjs-dist/standard_fonts', 'out/pdfjs/standard_fonts');
