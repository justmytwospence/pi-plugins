// Live result rows (bg_run, a waiting bg_wait) redraw while their task runs. Pi's invalidate
// re-renders the whole transcript, so a row redraws only when the line it shows changed.
interface Row { redraw: () => void; line: () => string; drawn: string }

export class LiveRows {
  private readonly rows = new Map<string, Map<string, Row>>();

  /** A row just drawn showing `line()`. Pi hands every render a fresh invalidate, so re-tracking a row replaces it. */
  track(taskId: string, rowKey: string, redraw: () => void, line: () => string): void {
    let drawn: string;
    try { drawn = line(); } catch { drawn = ""; }
    const rows = this.rows.get(taskId) ?? new Map<string, Row>();
    rows.set(rowKey, { redraw, line, drawn });
    this.rows.set(taskId, rows);
  }

  /** Redraws each row whose line changed; a task no longer running gets that last redraw, then its rows drop. */
  tick(running: (taskId: string) => boolean): void {
    for (const [taskId, rows] of [...this.rows]) {
      const live = running(taskId);
      for (const [key, row] of [...rows]) {
        let now: string;
        try { now = row.line(); } catch { rows.delete(key); continue; }
        if (now === row.drawn) continue;
        row.drawn = now;
        try { row.redraw(); } catch { rows.delete(key); }
      }
      if (!live) this.rows.delete(taskId);
    }
  }

  get size(): number {
    let n = 0;
    for (const rows of this.rows.values()) n += rows.size;
    return n;
  }
}
