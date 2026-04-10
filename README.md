# darkmark

![darkmark logo](media/logo.png)

A VS Code extension that opens `.md` files as a rendered dark-themed preview instead of raw text.

## Features

- Auto-renders all `.md` files in a dark-themed webview
- Syntax highlighting for code blocks (atom-one-dark theme)
- Live preview updates as you edit the source
- "Edit Source" button to switch back to raw text at any time

## Installation

1. Download the `.vsix` file from the [releases page](https://github.com/n1th1n/darkmark/releases)
2. Open VS Code → Extensions panel → `···` menu → **Install from VSIX**
3. Select the downloaded `.vsix` file

## Usage

Open any `.md` file — darkmark takes over automatically and renders it as a preview.

To edit the raw markdown, click the **Edit Source** button in the bottom-right corner of the preview, or right-click the file → **Open With** → **Text Editor**.

## Build from Source

```bash
npm install
npm run compile
vsce package
```

## Tech Stack

- [markdown-it](https://github.com/markdown-it/markdown-it) — markdown parsing
- [highlight.js](https://highlightjs.org/) — syntax highlighting
- VS Code `CustomReadonlyEditorProvider` API

## License

MIT
