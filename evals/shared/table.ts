/** Columns padded to their widest cell; the first column left-aligned, the rest right-aligned. */
export function table(rows: readonly (readonly (string | number)[])[]): string {
  const cells = rows.map((row) => row.map(String));
  const widths: number[] = [];
  for (const row of cells) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return cells.map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] as number) : cell.padStart(widths[i] as number))).join("  ").trimEnd()).join("\n");
}
