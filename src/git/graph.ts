// Lane assignment for the commit graph. Pure. Lanes never move sideways: a lane keeps its
// column until it ends, and freed columns are reused, so every edge is drawn within one row.

/** What to draw for one commit row. Columns are lane indexes. */
export interface GraphRow {
  /** Column of the commit's dot */
  col: number;
  /** Lanes that pass straight through the row */
  through: number[];
  /** Lanes entering from the top that end at the dot (the commit's children) */
  into: number[];
  /** Lanes leaving the dot toward the bottom (the commit's parents) */
  out: number[];
}

/** Hash each open lane waits for, null = free. Copy it to resume a later page. */
export type Lanes = (string | null)[];

export function layout(commits: { hash: string; parents: string[] }[], lanes: Lanes): GraphRow[] {
  const rows: GraphRow[] = [];
  for (const c of commits) {
    let col = lanes.indexOf(c.hash);
    const into: number[] = [];
    lanes.forEach((h, i) => { if (h === c.hash) into.push(i); });
    if (col < 0) col = free(lanes);
    for (const i of into) lanes[i] = null;

    const through = lanes.flatMap((h, i) => (h !== null && i !== col ? [i] : []));
    const out: number[] = [];
    c.parents.forEach((p, k) => {
      const existing = lanes.indexOf(p);
      // A parent already awaited by another lane: join it instead of opening a duplicate
      if (existing >= 0 && existing !== col) { out.push(existing); return; }
      const lane = k === 0 ? col : free(lanes, col);
      lanes[lane] = p;
      out.push(lane);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ col, through, into, out });
  }
  return rows;
}

/** First free column, never `skip` (the dot's own column while its first parent is being placed) */
function free(lanes: Lanes, skip = -1): number {
  for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && i !== skip) return i;
  lanes.push(null);
  return lanes.length - 1;
}
