// Streaming parser for `git log -z --format=` + LOG_FORMAT. Pure: no vscode, no child processes.

/** 7 fields, each NUL-terminated (with -z the record terminator is NUL too) */
export const LOG_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s';
const FIELDS = 7;

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** Unix seconds */
  time: number;
  /** Decorations: "HEAD -> main", "origin/main", "tag: v1" */
  refs: string[];
  subject: string;
}

/** Feed it chunks as they arrive; it returns every commit completed by that chunk */
export class LogParser {
  private rest = '';
  private fields: string[] = [];

  push(chunk: string): Commit[] {
    const parts = (this.rest + chunk).split('\0');
    this.rest = parts.pop()!; // text after the last NUL is an unfinished field
    const out: Commit[] = [];
    for (const p of parts) {
      this.fields.push(p);
      if (this.fields.length === FIELDS) {
        out.push(toCommit(this.fields));
        this.fields = [];
      }
    }
    return out;
  }
}

function toCommit(f: string[]): Commit {
  // A field may start with "\n" when git separates records with a newline (tformat without -z)
  const [hash, parents, author, email, time, refs, subject] = f.map((s, i) => (i === 0 ? s.trim() : s));
  return {
    hash,
    parents: parents ? parents.split(' ') : [],
    author,
    email,
    time: Number(time) || 0,
    refs: refs ? refs.split(', ') : [],
    subject,
  };
}
