// Unified diff parser and partial-patch builder for per-hunk and per-line staging. Pure.

export interface Hunk {
  /** The full "@@ -a,b +c,d @@ section" line */
  header: string;
  oldStart: number;
  newStart: number;
  /** Diff lines with their prefix: ' ', '+', '-' or '\' (no newline at end of file) */
  lines: string[];
}

export interface FileDiff {
  /** Lines before the first hunk: "diff --git", "index", "---", "+++", mode and rename lines */
  header: string[];
  hunks: Hunk[];
  binary: boolean;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Split `git diff` output into files and hunks */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      file = { header: [line], hunks: [], binary: false };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    const m = HUNK.exec(line);
    if (m) {
      hunk = { header: line, oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && /^[ +\-\\]/.test(line)) {
      hunk.lines.push(line);
    } else if (hunk && line === '') {
      hunk.lines.push(' '); // some tools strip the space of an empty context line
    } else {
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
      file.header.push(line);
    }
  }
  return files;
}

/**
 * Patch holding only the selected +/- lines of `hunk`, for `git apply --cached --recount`.
 * `reverse` builds it for a reverse apply (unstage from the index, discard from the worktree):
 * there, unselected '+' lines are already present and become context, and unselected '-' lines
 * are absent and are dropped. Forward it is the other way round. Null when nothing is selected.
 */
export function partialPatch(file: FileDiff, hunk: Hunk, selected: Set<number>, reverse = false): string | null {
  const out: string[] = [];
  let changes = 0, oldN = 0, newN = 0;
  let lastKept = true;
  hunk.lines.forEach((line, i) => {
    const t = line[0];
    if (t === '\\') { if (lastKept) out.push(line); return; }
    let kept: string | null = line;
    if ((t === '+' || t === '-') && !selected.has(i)) {
      const keepAsContext = reverse ? t === '+' : t === '-';
      kept = keepAsContext ? ' ' + line.slice(1) : null;
    } else if (t === '+' || t === '-') changes++;
    lastKept = kept !== null;
    if (kept === null) return;
    out.push(kept);
    if (kept[0] !== '+') oldN++;
    if (kept[0] !== '-') newN++;
  });
  if (!changes) return null;
  const header = `@@ -${hunk.oldStart},${oldN} +${hunk.newStart},${newN} @@`;
  return [...fileHeader(file), header, ...out].join('\n') + '\n';
}

/** Header lines git apply needs: everything except "index" (its blob ids would be wrong for a partial patch) */
function fileHeader(file: FileDiff): string[] {
  return file.header.filter((l) => !l.startsWith('index '));
}

/** Indexes of the +/- lines in a hunk: "select the whole hunk" */
export function allChanges(hunk: Hunk): Set<number> {
  return new Set(hunk.lines.flatMap((l, i) => (l[0] === '+' || l[0] === '-' ? [i] : [])));
}
