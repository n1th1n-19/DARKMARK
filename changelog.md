# 2026-04-09 16:00 — Initial build of darkmark VS Code extension

## New Files
- `package.json` — Extension manifest with `darkmark.preview` custom editor and `darkmark.openAsText` command
- `tsconfig.json` — TypeScript compiler config targeting ES2020 CommonJS with esModuleInterop
- `src/extension.ts` — Entry point; registers the custom editor provider and openAsText command
- `src/MarkdownEditorProvider.ts` — Implements `CustomReadonlyEditorProvider`; handles file reads, live updates, and editSource postMessage
- `src/markdownEngine.ts` — Converts markdown to a full webview HTML document using markdown-it; supports fragment-only mode for live updates
- `media/preview.css` — Full dark theme with all design tokens, typography, code blocks, blockquotes, tables, scrollbar, and Edit Source button styles
- `media/preview.js` — Client-side script: runs highlight.js, injects Edit Source button, handles live-update postMessages
