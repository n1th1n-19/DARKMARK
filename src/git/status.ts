// Parser for `git status --porcelain=v2 --branch -z`. Pure.

export interface FileStatus {
  path: string;
  /** Rename/copy source */
  orig?: string;
  /** Index status letter ('.' = unchanged, 'M', 'A', 'D', 'R', 'C', 'T', 'U') */
  x: string;
  /** Worktree status letter */
  y: string;
  conflict: boolean;
  untracked: boolean;
}

export interface Status {
  branch: string | null; // null = detached HEAD
  oid: string | null; // null = no commits yet
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileStatus[];
}

export function parseStatus(text: string): Status {
  const s: Status = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const tokens = text.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const [key, ...rest] = t.slice(2).split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') s.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.head') s.branch = val === '(detached)' ? null : val;
      else if (key === 'branch.upstream') s.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); }
      }
      continue;
    }
    const kind = t[0];
    if (kind === '?' || kind === '!') {
      if (kind === '?') s.files.push({ path: t.slice(2), x: '?', y: '?', conflict: false, untracked: true });
      continue;
    }
    // Fixed field counts before the path: path itself may contain spaces
    const n = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : -1;
    if (n < 0) continue;
    const parts = t.split(' ');
    const xy = parts[1];
    const path = parts.slice(n).join(' ');
    const f: FileStatus = { path, x: xy[0], y: xy[1], conflict: kind === 'u', untracked: false };
    if (kind === '2') f.orig = tokens[++i]; // rename source is the next NUL-separated token
    s.files.push(f);
  }
  return s;
}
