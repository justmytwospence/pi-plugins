// What the notebook view's `a` prompt sends the main agent: the user's words, then where they were
// looking, with the marimo-pair flags that name that notebook, so the agent can act on it at once.
import type { Cell } from "./core/notebook.js";
import { pairFlags, relativePath } from "./core/render.js";
import type { Followed } from "./core/watcher.js";

export function askMessage(text: string, f: Pick<Followed, "attachment" | "notebook">, cell: Cell | undefined, cwd: string): string {
  let ref = "the notebook";
  if (cell) {
    const section = f.notebook.sectionPath(cell.id);
    const marks = f.notebook.lens.selections().filter((s) => s.cells.includes(cell.id)).map((s) => s.label);
    ref = [
      `cell ${cell.id}`,
      cell.name !== "_" ? ` "${cell.name}"` : "",
      section.length ? ` under "${section.join(" › ")}"` : "",
      marks.length ? `, which has Lens selection${marks.length === 1 ? "" : "s"} ${marks.join(", ")}` : "",
    ].join("");
  }
  return `${text.trim()}\n\n(From pi-marimo's notebook view: about ${ref} in ${relativePath(f.attachment.path, cwd)}. marimo-pair: ${pairFlags(f.attachment)})`;
}
