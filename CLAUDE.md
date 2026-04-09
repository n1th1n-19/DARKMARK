# CLAUDE.md — darkmark (VS Code Extension)

> This file is the source of truth for the darkmark extension.
> Read this before writing, editing, or reviewing any code in this project.

---

## Project Overview

**darkmark** is a VS Code extension that replaces the default text editor for `.md` files with a rendered HTML preview in a dark-themed webview. Users can also switch back to raw text editing via a built-in "Edit Source" button or right-click → "Open With".

---

## Tech Stack

| Layer | Tool |
|---|---|
| Language | TypeScript |
| VS Code API | `CustomReadonlyEditorProvider`, `WebviewPanel` |
| Markdown Parser | `markdown-it` |
| Syntax Highlighting | `highlight.js` (theme: atom-one-dark) |
| Packaging | `vsce` |

---

## Project Structure

```
darkmark/
├── src/
│   ├── extension.ts                 ← Entry point. Registers CustomEditorProvider and darkmark.openAsText command.
│   ├── MarkdownEditorProvider.ts    ← Core provider. Implements CustomReadonlyEditorProvider.
│   └── markdownEngine.ts            ← Converts raw markdown string → full HTML string.
├── media/
│   ├── preview.css                  ← Dark theme styles for the webview.
│   └── preview.js                   ← highlight.js init + Edit Source button postMessage.
├── package.json                     ← Extension manifest. customEditors contribution lives here.
├── tsconfig.json
└── README.md
```

---

## Architecture

### How a `.md` file opens

1. User clicks any `.md` file in VS Code.
2. VS Code checks `package.json` → finds `customEditors` with `"priority": "default"` for `*.md`.
3. Calls `MarkdownEditorProvider.resolveCustomEditor()`.
4. Provider reads the file, runs it through `markdownEngine.ts`, injects HTML into a `WebviewPanel`.
5. User sees the rendered dark-theme preview — no raw text.

### Edit Source flow

1. User clicks the "Edit Source" button in the preview (fixed bottom-right).
2. `preview.js` sends `postMessage({ command: 'editSource' })` to the extension host.
3. `MarkdownEditorProvider` receives the message.
4. Calls `vscode.commands.executeCommand('vscode.openWith', uri, 'default')`.
5. Raw `.md` file opens in a new tab as plain text.

### Live update flow (when raw text editor is open)

1. User edits `.md` in the text editor.
2. `vscode.workspace.onDidChangeTextDocument` fires.
3. `markdownEngine.ts` re-parses the document text.
4. Provider calls `webview.postMessage({ command: 'update', html: '...' })`.
5. `preview.js` swaps `innerHTML` of the preview container.
6. `highlight.js` re-runs on all new code blocks.

---

## package.json — Critical Config

```json
"contributes": {
  "customEditors": [
    {
      "viewType": "darkmark.preview",
      "displayName": "darkmark",
      "selector": [{ "filenamePattern": "*.md" }],
      "priority": "default"
    }
  ],
  "commands": [
    {
      "command": "darkmark.openAsText",
      "title": "darkmark: Edit Source"
    }
  ]
}
```

> ⚠️ Do NOT change `"priority"` from `"default"` — this is what makes `.md` files open in the preview automatically.
> ⚠️ Do NOT change the `viewType` `"darkmark.preview"` — it is referenced in both `package.json` and `extension.ts`.

---

## Dark Theme — Design Tokens

These values are defined in `media/preview.css` and must not be changed without updating all usages.

```css
--bg-primary:     #0d1117;   /* Main preview background */
--bg-surface:     #161b22;   /* Code blocks, blockquotes, table headers */
--border:         #30363d;   /* Dividers, table borders, hr */
--text-primary:   #e6edf3;   /* Body text, headings */
--text-muted:     #8b949e;   /* Captions, metadata */
--accent:         #58a6ff;   /* Links, hover states */
--green:          #3fb950;   /* Inline code */
--purple:         #bc8cff;   /* H1, H2 headings */
--orange:         #ffa657;   /* Blockquote left border */
```

> ⚠️ Do NOT use hardcoded hex values anywhere in `preview.css`. Always use these CSS variables.

---

## Typography Rules

| Element | Font | Size | Weight |
|---|---|---|---|
| Body prose | `'Inter', sans-serif` | 15px | 400 |
| Code / pre | `'JetBrains Mono', monospace` | 13px | 400 |
| H1 | Inter | 2rem | 700 |
| H2 | Inter | 1.5rem | 600 |
| H3–H6 | Inter | scaled | 600 |

Fonts are loaded via Google Fonts inside the webview HTML boilerplate in `markdownEngine.ts`.

---

## Component Rules

### Code Blocks
- Background: `var(--bg-surface)`
- Border: `1px solid var(--border)`, border-radius `8px`
- Language badge displayed top-right
- highlight.js theme: **atom-one-dark** (loaded via CDN in webview)

### Blockquotes
- Left border: `3px solid var(--orange)`
- Background: `var(--bg-surface)`
- Text: italic, `var(--text-muted)`

### Tables
- Header background: `var(--bg-surface)`
- Row stripe: alternates `var(--bg-primary)` / `var(--bg-surface)`
- All borders: `var(--border)`

### "Edit Source" Button
- Position: fixed, bottom-right (`bottom: 24px; right: 24px`)
- Background: `#21262d`, border: `var(--border)`
- Hover: border-color `var(--accent)`, color `var(--accent)`
- Icon: ✏️ pencil + label "Edit Source"
- Sends `postMessage({ command: 'editSource' })` on click

### Scrollbar
- Track: `var(--bg-primary)`
- Thumb: `var(--border)`
- Thumb hover: `var(--accent)`
- Width: `6px`

---

## Rules — What Must NOT Be Changed

1. **`"priority": "default"`** in `package.json` — removing this breaks auto-open behavior.
2. **CSS variable names** in `preview.css` — all components depend on these exact names.
3. **`postMessage` command names** (`editSource`, `update`) — must match between `preview.js` and `MarkdownEditorProvider.ts`.
4. **`viewType: 'darkmark.preview'`** — must be identical in `package.json` and `extension.ts`.
5. **`markdownEngine.ts` output** must always return a complete HTML document string (not a fragment) — the webview sets it as `webview.html`.

---

## Build & Install

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Package as .vsix
vsce package

# Install in VS Code
# Extensions panel → ··· menu → Install from VSIX → select darkmark-1.0.0.vsix
```

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `markdown-it` | latest | Markdown → HTML parsing |
| `highlight.js` | via CDN | Syntax highlighting in webview |
| `@types/vscode` | `^1.74.0` | VS Code API types |
| `typescript` | latest | Compile TS → JS |
| `vsce` | latest | Package extension |

---

## Future Features (v2 — do not implement yet)

- Mermaid diagram rendering
- Table of contents sidebar panel
- Custom font/size settings via VS Code settings API
- PDF export via `puppeteer`
- GFM task list checkboxes (read-only)