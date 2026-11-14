# darkmark v3 plan — file viewers, Git client, GitHub

Status as of 2026-11-14. Phase 0 is shipped; the other phases are not started.

## Goal

Grow darkmark from a Markdown preview into a dark-themed viewer and Git workbench that works in both VS Code and VSCodium:

1. Viewers for spreadsheets, Word, PowerPoint, PDF and images.
2. A full, interactive Git client (graph, history, staging, branching, rebase, stash).
3. GitHub pull requests, issues and Actions through the `gh` CLI.

All of it must stay light on memory (see [Memory budget](#memory-budget)).

Everything ships in the one `darkmark` extension. Each phase is its own branch and PR into `main`; merging releases automatically (`.github/workflows/release.yml`, bump size from the PR label).

| Phase | Branch | Release | Label |
|---|---|---|---|
| 0 — VSCodium fix | `fix/vscodium` | v2.0.1 (done) | patch |
| 1 — Build, shell, viewers | `feat/viewers` | v3.0.0 | `major` |
| 1b — Slides viewer | `feat/slides` | v3.1.0 | `minor` |
| 2 — Git client | `feat/git` | v3.2.0 | `minor` |
| 3 — GitHub | `feat/github` | v3.3.0 | `minor` |

## Phase 0 — VSCodium fix (done, v2.0.1)

- Fixed: `.vscodeignore` stripped the runtime dependency `@vscode/markdown-it-katex`, so 2.0.0 could not activate.
- Added `publisher: n1th1n-19`, a CI check that the vsix contains the dependency, and an Open VSX publish step (skipped until the `OVSX_PAT` secret exists).
- PR #2, release v2.0.1. Installed and running in VSCodium 1.143.

**Still open (manual):** create an Open VSX token, run `npx ovsx create-namespace n1th1n-19 -p <token>`, add it as the `OVSX_PAT` repo secret.

---

## Memory budget

This applies to every phase. Measure with **Developer: Open Process Explorer** in VSCodium.

| Case | Limit (webview process) |
|---|---|
| 100-page PDF, scrolled end to end | 250 MB |
| 50,000-row sheet | 250 MB |
| 20 MB docx with images | 200 MB |
| Git panel, 5,000 commits scrolled | 200 MB |
| Extension host, darkmark's share, idle after closing all darkmark tabs | back within 20 MB of the starting level |

Rules:

1. **No file bytes go through `postMessage`.** A viewer gets the file's `webview.asWebviewUri(...)` and `fetch()`es it. Video and large images stream from disk; the extension host never holds a copy.
2. **No `retainContextWhenHidden` for the viewers or the Git panel.** A hidden tab with that option keeps its whole renderer alive. Save the view state (page, zoom, scroll, active sheet) with `vscode.setState()` and restore it when the tab comes back. Markdown keeps `retainContextWhenHidden` because it live-syncs with the text editor.
3. **Render only what is on screen.** PDF pages, sheet rows, Git graph rows and commit lists are virtualized. Anything that scrolls out of view is removed from the DOM and its canvas is released.
4. **Use blob URLs, not base64.** Embedded images (docx, pptx) become `URL.createObjectURL(blob)` and are revoked when the view reloads or closes. A base64 data URI keeps about 2.3 copies of the image in memory.
5. **Load code lazily.** Each viewer is its own bundle and loads only in its own tab. The Git and GitHub code is a separate bundle (`out/git.js`), loaded with `require()` the first time the panel opens, so a Markdown-only user never loads it.
6. **Stream child-process output.** Large outputs (`git log`, `git show`, `gh run view --log`) use `spawn` and are parsed as they arrive, never collected whole by `execFile`. `execFile` stops at its 1 MB `maxBuffer` anyway. Sizes are capped; see each phase.
7. **Clean up on close.** Every watcher, listener, child process and timer is registered with the panel's dispose. A running `git` or `gh` child is killed when its panel closes.

---

## Phase 1 — Build setup and file viewers (v3.0.0)

Branch: `feat/viewers`

### Build setup

The viewers need npm libraries inside the webview, which plain `tsc` cannot bundle. Add **esbuild** (one devDependency, one `build.mjs`):

- `out/extension.js`: the Node bundle, with `vscode` marked external.
- `out/webview/<viewer>.js`: one browser bundle per viewer.
- `build.mjs` also copies the runtime files that are loaded by URL, not by import, into `out/`:
  - `katex/dist/katex.min.css` and `katex/dist/fonts/`. Today [markdownEngine.ts](../src/markdownEngine.ts) loads these from `node_modules`. Switch that path to `out/katex/`.
  - the pdfjs worker (`pdf.worker.min.mjs`), plus its `cmaps/` and `standard_fonts/`.
- `npm run build` runs `tsc --noEmit` first, because esbuild does not check types.
- `vscode:prepublish` changes from `npm run compile` to `npm run build`.
- Package with `vsce package --no-dependencies` in **both** `ci.yml` and `release.yml`. Everything is bundled, so `node_modules` no longer ships, which removes the class of bug fixed in Phase 0.
- Replace the CI check: unzip the vsix and assert that `out/extension.js`, `out/webview/*.js`, `out/katex/katex.min.css` and `out/pdfjs/pdf.worker.min.mjs` are all present.
- Before switching, search `src/` and `media/` for `node_modules`. Every hit must move to `out/`.

### Shared webview shell

Move the HTML/CSP template out of `src/markdownEngine.ts` into `src/webviewShell.ts`:

```ts
shell(webview, context, { body, scripts, styles, csp }): string
```

It keeps the per-render script nonce and the dark design tokens from `media/preview.css`, and adds an "Open with default editor" button. Every viewer, and later the Git panel, uses it.

The viewers' CSP is stricter than the Markdown one:

```
default-src 'none';
script-src 'nonce-…';
style-src ${cspSource} 'unsafe-inline';
img-src ${cspSource} blob: data:;
media-src ${cspSource} blob:;
connect-src ${cspSource};
worker-src blob:;          (PDF only)
font-src ${cspSource};
```

There is no `https:`, so a document cannot load remote images or tracking pixels.

### Viewer provider

`src/viewers/BinaryViewerProvider.ts` holds one `CustomReadonlyEditorProvider` that all viewers share. A viewer is described as `{ viewType, script }`.

- `localResourceRoots` contains the extension folder and the file's own folder.
- The provider gives the webview the file's webview URI and never reads the file itself.
- When the file changes on disk (same watcher pattern as `MarkdownEditorProvider.ts`), it posts `{ command: 'reload' }`. The viewer fetches again with a cache-busting query (`?v=<mtime>`) and restores its state.
- Register with `supportsMultipleEditorsPerDocument: false` and without `retainContextWhenHidden`.

Markdown keeps its own provider because it live-syncs with the text editor.

### Viewers

| Viewer | File types | Library | Behaviour and memory |
|---|---|---|---|
| Sheet | xlsx, xls, ods, csv, tsv | SheetJS, installed from the `cdn.sheetjs.com` tarball (the npm `xlsx@0.18.5` has known CVEs) | Sheet tabs, sticky header row and column, number/date/text styling. Parse with `{ dense: true, sheetRows: 50001 }` and only the active sheet (`sheets` option). Rows are virtualized: only the visible rows plus a 50-row buffer are in the DOM. First 50,000 rows only. |
| Word | docx | mammoth (browser build) | Converted to HTML in the dark theme. Images go through `convertImage` into blob URLs, not base64. |
| PDF | pdf | pdfjs-dist | Pages, zoom, page navigation, selectable/searchable text layer. Only visible pages ±1 are rendered; when a page leaves that range its canvas is set to 0×0 and `page.cleanup()` runs. Canvas scale is capped at `min(devicePixelRatio, 2)`. The worker is fetched from `out/pdfjs/` and started from a blob URL. |
| Image | png, jpg, jpeg, gif, webp, svg, bmp, ico, avif | none | Fit / 1:1 / wheel zoom / pan, checkerboard background, dimensions and file size. Plain `<img decoding="async">` pointing at the webview URI. Zoom and pan use CSS `transform`, with no canvas copy. |

Priorities:

- Sheet (xlsx, xls, ods), Word and PDF use `priority: "default"`, because VS Code and VSCodium have no built-in viewer for them.
- CSV and TSV use the same sheet viewer under a second view type (`darkmark.csv`) with `priority: "option"`, because they are text files people often edit.
- Image uses `priority: "option"`, so it does not replace the built-in image preview. Users pick it with "Reopen Editor With…".
- There is no media viewer: the built-in video and audio preview already does the same job.

Turning a viewer off is done with VS Code's own setting, documented in the README, for example:

```json
"workbench.editorAssociations": { "*.pdf": "default" }
```

There are no `darkmark.viewers.*.enabled` settings: `customEditors` in `package.json` is static, and a setting cannot unregister an editor.

### Security

docx content is untrusted. It is rendered inside the shell's CSP, which only runs scripts carrying the nonce and blocks every remote load. SVG is shown through `<img>`, where its scripts never run.

### Acceptance

- Add `test/assets/sample.{xlsx,csv,docx,pdf,png}`, plus a 100-page PDF and a 50,000-row CSV for the memory checks.
- Each opens in VSCodium with no activation error ("Developer: Show Running Extensions").
- Markdown preview still works, math included (`test/fixture.md`).
- The memory budget holds for the PDF, sheet and docx cases.
- Switching to another tab and back restores the page, zoom and scroll.

---

## Phase 1b — Slides viewer (v3.1.0)

Branch: `feat/slides`

This is split out because it needs its own slide-XML parser and is the riskiest viewer.

- pptx via jszip and an own parser: slide list, positioned text boxes, images, speaker notes. Approximate.
- Only the current slide is fully rendered. The slide list uses small thumbnails, made only for the visible list items.
- Images become blob URLs. Relationships with `TargetMode="External"` are ignored.
- All text is escaped. No XML is ever inserted as HTML.
- `priority: "default"`.

Acceptance: `test/assets/sample.pptx` opens; the docx memory limit holds for a 20 MB deck.

---

## Phase 2 — Interactive Git client (v3.2.0)

Branch: `feat/git`

### Backend

`src/git/git.ts` runs `git` through `execFile` or `spawn` with an argument array, never a shell string, so repository content can't inject commands. It has typed parsers for each command's output. The built-in `vscode.git` extension is used only for `toGitUri`, to open native diff editors.

Every call sets this environment:

| Variable | Value | Why |
|---|---|---|
| `GIT_TERMINAL_PROMPT` | `0` | There is no terminal. A credential prompt would hang forever; it fails instead, and the panel shows the error. SSH keys and credential helpers still work. |
| `GIT_EDITOR` | a script in `out/` that writes the message the panel supplied, or keeps the default message | Without it, `rebase --continue`, reword and squash would open an editor and hang. |
| `GIT_SEQUENCE_EDITOR` | a script that writes the edited todo list | For interactive rebase. |
| `LC_ALL` | `C` | The parsers expect stable output. |

`merge`, `revert` and `cherry-pick` always pass `--no-edit`, unless the panel collected a message. Every call has a timeout; network calls (fetch, pull, push) get 120 s, and the rest get 30 s.

Big outputs are streamed:

- `git log` is run with `spawn` and parsed record by record.
- A diff larger than 512 KB, or a file diff larger than 5,000 lines, is not shown inline. The panel shows "Diff too large — open in diff editor".

The repository paths come from `git rev-parse --show-toplevel --git-dir`, never from a hard-coded `<root>/.git`, because in a worktree or submodule `.git` is a file.

### Panel

A `darkmark: Git` webview panel in the editor area, opened by the `darkmark.git.open` command or a status-bar item. There is one panel at most: opening it again reveals the existing one. The repository is the workspace folder of the active file.

The panel's code lives in `out/git.js` and is loaded the first time the panel opens. The status-bar item is registered on activation but runs no git commands until the panel is opened.

### Views

- **Graph and history.**
  - Command: `git log --all --date-order -z --format=%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s`, loaded 300 commits at a time with `--skip` as you scroll.
  - Parsing: with `-z`, both the records and the `%x00` fields end in NUL, so split the stream into groups of exactly 7 fields.
  - A lane-assignment algorithm draws the graph. Its open-lanes state carries over from one page to the next, so lanes stay correct across page boundaries.
  - Rows are virtualized, and the SVG is drawn only for visible rows.
  - The webview keeps at most 5,000 commits. Older pages are dropped and refetched if you scroll back.
  - Branch, tag and HEAD labels. Search by message, author, hash or path; search runs in `git log`, not over the loaded rows.
- **Commit detail.** Changed files (`git show --numstat --format=`), an inline unified diff (own parser) loaded only when a file is expanded, and a button to open the native diff editor.
- **Working tree.**
  - Status comes from `git status --porcelain=v2 -z`.
  - Stage and unstage per file, per hunk and per line. The panel generates a patch and applies it with `git apply --cached --recount`, so hunk headers don't have to be exact.
  - Discard asks for confirmation.
  - Commit box with amend and sign-off.
- **File history and blame.** From the explorer and editor context menus: `git log --follow -- <path>` (paged like the graph) and `git blame --porcelain` (streamed).

### Actions

You open them by right-clicking a commit or branch. Destructive actions ask for confirmation inside the panel.

- Checkout; create, rename and delete branch; merge; rebase onto.
- **Interactive rebase:** drag to reorder, choose pick / squash / fixup / reword / drop. Runs `git rebase -i` with the `GIT_SEQUENCE_EDITOR` and `GIT_EDITOR` scripts above. Reword and squash messages are collected in the panel before the rebase starts.
- Cherry-pick, revert, reset (soft / mixed / hard), create and delete tags.
- Stash list with save, apply, pop and drop.
- Fetch, pull, push. Force push is offered only as `--force-with-lease`.
- **Conflicts:** a banner lists the conflicted files and opens them in the merge editor. It offers continue (with `GIT_EDITOR`, so it never hangs) and abort.

### Refresh

The panel refreshes when `HEAD`, `index` or `refs/**` change inside the git dir, debounced by 300 ms. It refreshes only while the panel is visible; a hidden panel marks itself stale and refreshes when shown.

### Tests

These use Node's built-in test runner, with no framework, and run as `npm test` in CI:

- `test/git-graph.test.mjs`: lane assignment on a fixture log with merges, including a merge that crosses the 300-commit page boundary.
- `test/log-parse.test.mjs`: 7-field NUL splitting, including empty `%D` and empty `%P` (root commit).
- `test/diff-parse.test.mjs`: hunk parsing, and a round trip through partial-patch generation.

### Acceptance

Run these in a throwaway repository with branches, a merge and a conflict:

- Graph lanes are correct.
- Hunk staging matches `git diff --cached`.
- An interactive-rebase squash and a reword both finish without hanging.
- Conflict continue and abort both work.
- Push to a remote without credentials fails with a message within the timeout, instead of hanging.
- The Git-panel memory limit holds.

---

## Phase 3 — GitHub through `gh` (v3.3.0)

Branch: `feat/github`

`src/github/gh.ts` calls `gh` through `execFile` with `--json` output and an explicit `--limit` on every list (default 50). On start it runs `gh auth status`. If `gh` is missing or logged out, the tab shows the install / `gh auth login` command to copy. The extension never handles tokens.

The **GitHub** tab inside the Git panel has:

- **Pull requests:**
  - list (open, mine, review requested);
  - detail with the body rendered by the existing Markdown engine, under the viewers' strict CSP;
  - checks (`gh pr checks`) and diff (`gh pr diff`, streamed, same size cap as Phase 2);
  - comment; review (approve, request changes, comment);
  - checkout; merge (merge / squash / rebase, optionally deleting the branch);
  - create from the current branch (title, body, base, draft, labels).
- **Issues:** list and filter, view, comment, create, close and reopen.
- **Actions:**
  - `gh run list` for the current branch;
  - failed-step logs (`gh run view --log-failed`), streamed, with only the last 2,000 lines kept;
  - rerun.
- **Graph link:** commits that belong to a PR show its number (`gh pr list --json headRefOid,number`). The result is cached per panel session and refetched on fetch, pull or push.

### Acceptance

Against `n1th1n-19/DARKMARK`:

- List PRs and open one.
- Create a draft PR from a test branch, then close it.

---

## Every phase

1. Branch from `main`.
2. `npm run build && npm test && npx vsce package --no-dependencies`.
3. `codium --install-extension darkmark-X.Y.Z.vsix --force`, then check the phase's acceptance list in VSCodium, including the memory limits in Process Explorer.
4. Update `README.md`, `RELEASE_NOTES.md` and `changelog.md`.
5. PR into `main` with the right label; merging releases it.

## Known limits (state them in the README)

- PowerPoint rendering is approximate: no SmartArt, charts or animations.
- Sheets show the first 50,000 rows.
- The Git graph loads 300 commits at a time and keeps at most 5,000 in view.
- Large diffs (over 512 KB) open in the native diff editor instead of inline.
- The built-in video and audio preview handles media; darkmark has no media viewer.
- To turn off a darkmark viewer, use `workbench.editorAssociations`.
