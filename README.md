# darkmark

![darkmark logo](media/logo.png)

A VS Code extension that opens `.md` files as a rendered dark-themed preview instead of raw text.

[![darkmark v2 demo](media/demo.gif)](media/demo.mp4)

<sub>Click for the full-quality video with sound.</sub>

## Features

- Auto-renders all `.md` files in a dark-themed webview
- **Images, video and audio**: relative paths (`![](./shot.png)`, `<img>`, `<video>`) resolve next to the `.md` file. `![](clip.webm)` / `![](song.mp3)` render as players. YouTube `<iframe>` embeds work
- **Math**: `$inline$`, `$$block$$` and ` ```math ` via KaTeX
- **Mermaid diagrams** in ` ```mermaid ` blocks
- **Task lists**: `- [ ]` / `- [x]` render as checkboxes
- **Heading anchors + Contents panel**: jump to any h1–h3. `#anchor` links scroll
- **Working links**: other `.md` files open in darkmark, other files in VS Code, web links in your browser
- **Copy button** on every code block
- Syntax highlighting for code blocks (atom-one-dark theme)
- Live preview while you edit the source, or when the file changes on disk
- "Edit Source" button to switch back to raw text at any time

> **Video formats:** VS Code ships without proprietary codecs, so H.264 `.mp4` files may not play. Use `.webm` for reliable playback.

## Installation

1. Download the `.vsix` file from the [releases page](https://github.com/n1th1n-19/DARKMARK/releases)
2. Open VS Code → Extensions panel → `···` menu → **Install from VSIX**
3. Select the downloaded `.vsix` file

## Usage

Open any `.md` file — darkmark takes over automatically and renders it as a preview.

To edit the raw markdown, click the **Edit Source** button in the bottom-right corner of the preview, or right-click the file → **Open With** → **Text Editor**.

## Build from Source

```bash
npm install
npm run package
```

## Releases

Every PR merged into `main` is released automatically (`.github/workflows/release.yml`):

- Version bump comes from PR labels: `major`, `minor`, otherwise patch.
- If the PR already bumped `package.json` to a version that hasn't been released yet, that version is released as-is.
- The workflow commits the bump to `main`, tags `vX.Y.Z`, and attaches the `.vsix` to a GitHub Release.

If you protect `main`, let `github-actions[bot]` push to it, or the bump commit will fail.

## Tech Stack

- [markdown-it](https://github.com/markdown-it/markdown-it) — markdown parsing
- [highlight.js](https://highlightjs.org/) — syntax highlighting
- [KaTeX](https://katex.org/) via [@vscode/markdown-it-katex](https://github.com/microsoft/vscode-markdown-it-katex) — math
- [Mermaid](https://mermaid.js.org/) — diagrams
- VS Code `CustomReadonlyEditorProvider` API

## License

MIT
