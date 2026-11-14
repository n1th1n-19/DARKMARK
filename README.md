# darkmark

![darkmark logo](media/logo.png)

A VS Code and VSCodium extension that opens Markdown, spreadsheets, Word documents, PDFs and images in dark-themed viewers.

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

## Viewers

| File types | Opens by default? | What you get |
|---|---|---|
| `.xlsx` `.xls` `.ods` | yes | Sheet tabs, sticky column letters and row numbers, number/date/boolean styling |
| `.csv` `.tsv` | no: right-click → **Open With…** → *darkmark Sheet* | The same grid, with quoted fields and embedded newlines handled |
| `.docx` | yes | The document converted to HTML in the dark theme, with images, tables and working links |
| `.pptx` | yes | Slide list with thumbnails, the current slide with text, shapes, images and tables, and speaker notes |
| `.pdf` | yes | Pages, zoom, fit width, page navigation, search, selectable text |
| `.png` `.jpg` `.gif` `.webp` `.svg` `.bmp` `.ico` `.avif` | no: **Open With…** → *darkmark Image* | Fit / 1:1, wheel zoom around the cursor, drag to pan, checkerboard behind transparency, size info |

Every viewer has an **Open with default editor** button, and VS Code's find widget (<kbd>Ctrl</kbd>+<kbd>F</kbd>) works in all of them.

To turn a viewer off, or make one the default, use VS Code's own setting:

```json
"workbench.editorAssociations": {
  "*.pdf": "default",
  "*.csv": "darkmark.csv"
}
```

View types: `darkmark.preview` (Markdown), `darkmark.sheet`, `darkmark.csv`, `darkmark.docx`, `darkmark.slides`, `darkmark.pdf`, `darkmark.image`.

### Light on memory

- Files are never copied into the extension: the viewer streams them straight from disk.
- Viewers render only what is on screen: PDF pages near the viewport, sheet rows in view.
- A viewer tab you switch away from frees its memory and comes back at the same page, zoom and scroll.

### Limits

- Sheets show the first 50,000 rows and 1,000 columns.
- Slides are approximate: SmartArt, charts, video and embedded objects show as a labelled box, and animations and transitions are not played.
- Password-protected PDFs aren't supported yet.
- Video and audio files use VS Code's built-in preview.

## Installation

1. Download the `.vsix` file from the [releases page](https://github.com/n1th1n-19/DARKMARK/releases)
2. Open VS Code → Extensions panel → `···` menu → **Install from VSIX**
3. Select the downloaded `.vsix` file

**VSCodium** (or any fork using Open VSX): install from [Open VSX](https://open-vsx.org/extension/n1th1n-19/darkmark), or from the terminal:

```bash
codium --install-extension darkmark-X.Y.Z.vsix
```

> Upgrading from 2.0.0 (VS Code or VSCodium)? It installed as `undefined_publisher.darkmark`. Remove it first: `code --uninstall-extension undefined_publisher.darkmark` (or `codium …`).

## Usage

Open any `.md` file — darkmark takes over automatically and renders it as a preview.

To edit the raw markdown, click the **Edit Source** button in the bottom-right corner of the preview, or right-click the file → **Open With** → **Text Editor**.

## Build from Source

```bash
npm install
npm run build      # typecheck + esbuild bundles into out/
npm test
npm run package    # vsce package --no-dependencies
```

Everything the extension needs at runtime is bundled into `out/`; `node_modules` is not shipped.

To try a viewer bundle in a normal browser, run `python3 -m http.server 8123` from the repo root and open `http://localhost:8123/test/harness.html?viewer=pdf&file=test/assets/sample.pdf`. The large memory-check files (`test/assets/big.*`) aren't committed; generate them with the scripts in `test/assets/`.

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
- [SheetJS](https://sheetjs.com/) — xlsx, xls and ods
- [mammoth](https://github.com/mwilliamson/mammoth.js) — docx to HTML
- [PDF.js](https://mozilla.github.io/pdf.js/) — PDF rendering
- [esbuild](https://esbuild.github.io/) — bundling
- VS Code `CustomReadonlyEditorProvider` API

## License

MIT
