# Release Notes

## v2.0.0 — 2026-10-03

### Highlights

- **Media in previews.** Local images, videos and audio referenced from the markdown now display. Relative paths resolve against the `.md` file's folder, including files outside the workspace. `![](clip.webm)` and `![](song.mp3)` render as players, and raw `<img>`, `<video>`, `<audio>` and YouTube `<iframe>` tags work.
- **Math** with KaTeX: `$…$`, `$$…$$` and ` ```math ` blocks. Rendered by the extension, so it works offline.
- **Mermaid diagrams** in ` ```mermaid ` blocks, dark themed.
- **Task lists**: `- [ ]` / `- [x]` render as checkboxes.
- **Heading anchors + Contents panel**: GitHub-style heading ids, a "Contents" button to jump between h1–h3, and `#anchor` links scroll in place.
- **Working links**: relative `.md` links open in darkmark, other files open in VS Code, and web/mail links open externally.
- **Copy button** on code blocks.
- **Reload on disk change**: the preview refreshes when the file changes outside the editor (git checkout, other tools).
- **New logo**: a bold Markdown "M↓" mark.

### Tooling

- CI builds the `.vsix` on every PR.
- Each merged PR auto-releases: version bump from labels (`major` / `minor` / patch), git tag, GitHub Release with the `.vsix` attached.

### Known Limitations

- H.264 `.mp4` may not play (VS Code ships without proprietary codecs). Use `.webm`.
- Preview is still read-only, and checkboxes can't be toggled. PDF export is not planned yet.

---

## v1.0.0 — 2026-04-10

### Initial Release

**darkmark** is a VS Code extension that replaces the default Markdown editor with a beautiful dark-themed HTML preview — no configuration required.

---

### Features

- **Auto-preview for `.md` files** — Opens all Markdown files as a rendered dark-theme preview by default. No manual steps needed.
- **Dark theme** — GitHub-inspired dark palette with carefully chosen colors for text, headings, code, blockquotes, tables, and links.
- **Syntax highlighting** — Code blocks are highlighted using highlight.js (atom-one-dark theme), with a language badge displayed in the top-right corner of each block.
- **Edit Source button** — A fixed "Edit Source" button in the bottom-right corner lets you switch to raw text editing at any time.
- **Live update** — When a `.md` file is also open in a text editor, the preview updates in real time as you type.
- **"Open With" support** — Right-click any `.md` file and choose "Open With" to switch between the preview and the default text editor.
- **Typography** — Body text uses Inter; code uses JetBrains Mono. Both are loaded automatically inside the webview.

---

### Tech Stack

| Component | Technology |
|---|---|
| Language | TypeScript |
| VS Code API | `CustomReadonlyEditorProvider` |
| Markdown parser | markdown-it v14 |
| Syntax highlighting | highlight.js (atom-one-dark, via CDN) |
| Packaging | @vscode/vsce |

---

### Installation

1. Download `darkmark-1.0.0.vsix` from the [releases page](https://github.com/n1th1n/darkmark/releases).
2. Open VS Code → Extensions panel → `···` menu → **Install from VSIX**.
3. Select `darkmark-1.0.0.vsix`.
4. Reload VS Code — all `.md` files will now open in the dark preview.

---

### Known Limitations

- Preview is **read-only** — editing happens in the raw text editor via "Edit Source".
- Mermaid diagrams, task list checkboxes, and PDF export are planned for v2.
