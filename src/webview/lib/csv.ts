// Pure sheet helpers (no DOM, no SheetJS) so they can be unit tested in Node.

export const MAX_ROWS = 50_000;
export const MAX_COLS = 1_000;

export const enum Kind { Empty, Text, Num, Date, Bool }

// kind is one flat array (row * cols + col): 50k tiny typed arrays would cost more than the data
export interface Sheet { text: string[][]; kind: Uint8Array; rows: number; cols: number; widths: number[]; cutRows: boolean; cutCols: boolean }

const NUM = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?)?$/;

function kindOf(v: string): Kind {
  if (!v) return Kind.Empty;
  if (NUM.test(v)) return Kind.Num;
  if (DATE.test(v)) return Kind.Date;
  if (/^(true|false)$/i.test(v)) return Kind.Bool;
  return Kind.Text;
}

/**
 * RFC 4180 CSV/TSV straight to display strings. SheetJS would build a cell object
 * per value first, which costs several times the memory on large files.
 */
export function parseDelimited(src: string, sep: string): Sheet {
  const rowsText: string[][] = [];
  let row: string[] = [];
  let i = 0, cols = 0;
  const n = src.length;
  // One extra row beyond header + MAX_ROWS tells us the file was cut
  while (i < n && rowsText.length < MAX_ROWS + 2) {
    let v = '';
    if (src[i] === '"') {
      i++;
      for (;;) {
        const q = src.indexOf('"', i);
        if (q < 0) { v += src.slice(i); i = n; break; }
        v += src.slice(i, q);
        if (src[q + 1] === '"') { v += '"'; i = q + 2; } else { i = q + 1; break; }
      }
      // Stray characters between the closing quote and the separator are kept, like Excel does
      while (i < n && src[i] !== sep && src[i] !== '\n' && src[i] !== '\r') v += src[i++];
    } else {
      let j = i;
      while (j < n && src[j] !== sep && src[j] !== '\n' && src[j] !== '\r') j++;
      v = src.slice(i, j);
      i = j;
    }
    if (row.length < MAX_COLS) row.push(v);
    else if (row.length === MAX_COLS) cols = MAX_COLS + 1;
    if (src[i] === sep) { i++; continue; }
    if (src[i] === '\r') i++;
    if (src[i] === '\n') i++;
    cols = Math.max(cols, row.length);
    rowsText.push(row);
    row = [];
  }
  const cut = rowsText.length > MAX_ROWS + 1 || i < n;
  if (rowsText.length > MAX_ROWS + 1) rowsText.length = MAX_ROWS + 1;
  const cutCols = cols > MAX_COLS;
  cols = Math.min(cols, MAX_COLS);
  const rows = rowsText.length;
  const kind = new Uint8Array(rows * cols);
  let any = false;
  const longest = new Array(cols).fill(0);
  for (let r = 0; r < rows; r++) {
    const t = rowsText[r];
    for (let c = 0; c < t.length; c++) {
      const k = kindOf(t[c]);
      kind[r * cols + c] = k;
      if (k) any = true;
      if (r < 200 && t[c].length > longest[c]) longest[c] = t[c].length;
    }
  }
  if (!any) return { text: [], kind: new Uint8Array(0), rows: 0, cols: 0, widths: [], cutRows: false, cutCols: false };
  const widths = longest.map((len) => Math.round(Math.min(Math.max(len * 7 + 16, 40), 400)));
  return { text: rowsText, kind, rows, cols, widths, cutRows: cut, cutCols };
}

