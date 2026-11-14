# 2026-11-14 — v3.0.0: build setup and file viewers

## Changes

- `package.json` — esbuild build (`npm run build` = typecheck + bundle), `npm test`, `vsce package --no-dependencies`; viewer custom editors (`darkmark.sheet`, `darkmark.csv`, `darkmark.docx`, `darkmark.pdf`, `darkmark.image`); SheetJS, mammoth, pdfjs-dist, jszip
- `src/extension.ts` — registers the viewers (no `retainContextWhenHidden`, find widget on)
- `src/markdownEngine.ts` — renders through the shared shell; KaTeX CSS from `out/katex/`
- `media/preview.css` — design tokens moved to `media/tokens.css`
- `tsconfig.json` — typecheck only (`noEmit`); webview code checked by `tsconfig.webview.json`
- `.vscodeignore` — ships `out/` and `media/` only
- `.github/workflows/ci.yml`, `release.yml` — Node 22, build + test, `--no-dependencies`, vsix content check
- `docs/PLAN-v3.md` — measured memory budget

## New Files

- `build.mjs` — bundles `out/extension.js` and `out/webview/*.js`, copies KaTeX and PDF.js runtime files
- `src/webviewShell.ts` — shared HTML/CSP template with a per-render nonce; strict viewer CSP
- `src/viewers/BinaryViewerProvider.ts` — one read-only custom editor for all viewers; the webview fetches the file by URL
- `src/webview/common.ts` — shared webview helpers (state, toolbar, reload on change)
- `src/webview/sheet.ts`, `docx.ts`, `pdf.ts`, `image.ts` (+ `.css`) — the viewers
- `src/webview/lib/csv.ts` — RFC 4180 parser for CSV/TSV
- `media/tokens.css`, `media/viewer.css` — shared styles
- `tsconfig.webview.json`
- `test/build.test.mjs`, `test/csv.test.mjs`, `test/harness.html`
- `test/assets/sample.{xlsx,csv,docx,pdf,png,svg}` and generator scripts for the large memory-check files

---

# 2026-10-03 — v2.0.0: media, math, diagrams, auto-release

## Changes

- `src/markdownEngine.ts` — `<base href>` to the doc folder so relative media/links resolve; video/audio image renderer; heading ids; task lists; KaTeX plugin; mermaid fences; CSP adds `media-src`, `frame-src` (YouTube)
- `src/MarkdownEditorProvider.ts` — `localResourceRoots` includes doc folder; link routing (`openLink`, `openExternal` restricted to http/https/mailto); file watcher refresh
- `media/preview.js` — `enhance()` runs hljs, copy buttons, TOC, mermaid after every render; click routing for links
- `media/preview.css` — media, task list, copy button, TOC, math, mermaid styles
- `media/logo.svg`, `media/logo.png` — new "M↓" logo (PNG now 256px)
- `package.json` — v2.0.0, fixed repository URL, `vscode:prepublish` + `package` scripts, `@vscode/markdown-it-katex` dep
- `tsconfig.json` — `skipLibCheck` (KaTeX types reference DOM)

## New Files

- `.github/workflows/ci.yml` — build `.vsix` on PRs
- `.github/workflows/release.yml` — auto bump + tag + GitHub Release on merged PRs
- `test/fixture.md` — manual test document covering every v2 feature

---

# 2026-04-10 — Integrate logo across extension and README

## Changes

- `package.json` — Added `"icon": "media/logo.png"` so the logo appears in the VS Code extensions panel
- `src/markdownEngine.ts` — Added logo as webview favicon (`<link rel="icon">`) so it shows in the preview tab
- `README.md` — Added logo image at the top of the file

## New Files

- `media/logo.png` — PNG export of the SVG logo (required by vsce for the extension icon field)

---

# 2026-04-10 — Add project logo SVG

## New Files

- `media/logo.svg` — Project logo: dark rounded background, bookmark shape, glowing `#` symbol in purple-to-blue gradient; uses design tokens from `preview.css`

---

# 2026-04-09 16:00 — Initial build of darkmark VS Code extension

## New Files
- `package.json` — Extension manifest with `darkmark.preview` custom editor and `darkmark.openAsText` command
- `tsconfig.json` — TypeScript compiler config targeting ES2020 CommonJS with esModuleInterop
- `src/extension.ts` — Entry point; registers the custom editor provider and openAsText command
- `src/MarkdownEditorProvider.ts` — Implements `CustomReadonlyEditorProvider`; handles file reads, live updates, and editSource postMessage
- `src/markdownEngine.ts` — Converts markdown to a full webview HTML document using markdown-it; supports fragment-only mode for live updates
- `media/preview.css` — Full dark theme with all design tokens, typography, code blocks, blockquotes, tables, scrollbar, and Edit Source button styles
- `media/preview.js` — Client-side script: runs highlight.js, injects Edit Source button, handles live-update postMessages
