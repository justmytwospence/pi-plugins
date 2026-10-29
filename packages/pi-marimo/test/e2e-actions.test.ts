// Opt-in against a real marimo: PI_MARIMO_LIVE_TEST=1 and `marimo` on PATH. What the view does to a
// notebook, end to end: Pi starts the server, opens the notebook without a browser, runs its cells,
// sets a widget, runs Python in the scratchpad, and (when marimo-lens is installed) marks a cell.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { HeadlessSessions } from "../src/core/headless.js";
import { nodeIo } from "../src/core/node-io.js";
import { MarimoWatcher } from "../src/core/watcher.js";
import { OwnServers } from "../src/servers.js";
import { runCells, setUiValues } from "../src/ui/interrupt.js";
import { markCell, unmarkSelection } from "../src/ui/lens-mark.js";
import { runScratch, type ScratchEvent } from "../src/ui/scratch.js";

const live = (() => {
  if (process.env.PI_MARIMO_LIVE_TEST !== "1") return false;
  try {
    execFileSync("marimo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const NOTEBOOK = `import marimo

app = marimo.App()


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell
def _(mo):
    n = mo.ui.slider(0, 10, value=3, label="n")
    n
    return (n,)


@app.cell
def _(n):
    doubled = n.value * 2
    print(f"doubled={doubled}")
    doubled
    return (doubled,)


if __name__ == "__main__":
    app.run()
`;

const servers = new OwnServers();
const headless = new HeadlessSessions();
afterAll(() => {
  headless.closeAll();
  servers.stopAll();
});

async function until<T>(check: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.skipIf(!live)("a notebook Pi starts: run, set a widget, run Python, mark a cell", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-marimo-actions-")));
  const file = join(dir, "nb.py");
  writeFileSync(file, NOTEBOOK);
  const server = await servers.start({ command: ["marimo"], file, cwd: dir, timeoutMs: 60_000 });
  const sessionId = await headless.attach(server.url, file);
  const watcher = new MarimoWatcher({ io: nodeIo(), cwd: dir, pollMs: 300, onChange: () => undefined });
  watcher.start();
  try {
    const f = await until(() => watcher.followed().find((o) => o.attachment.path === file && o.connection === "connected" && o.notebook.ready));
    expect(f.attachment.sessionId).toBe(sessionId);
    const nb = f.notebook;
    await runCells(f.attachment, nb.ordered().map((c) => ({ id: c.id, code: c.code })));
    const doubled = await until(() => nb.ordered().find((c) => c.code.includes("doubled =") && c.output?.text === "6"));
    const slider = await until(() => nb.ordered().map((c) => c.output?.widgets?.[0]).find((w) => w?.kind === "slider"));
    expect(slider).toMatchObject({ label: "n", initial: 3, start: 0, stop: 10 });
    await setUiValues(f.attachment, [slider.objectId], [7]);
    await until(() => doubled.output?.text === "14");
    expect(doubled.lastRunMs).toBeGreaterThanOrEqual(0);

    const events: ScratchEvent[] = [];
    const result = await runScratch(f.attachment, "print(n.value + 1)", undefined, (e) => events.push(e));
    expect(events).toContainEqual({ stream: "stdout", text: "8" });
    expect(result.success).toBe(true);

    const lens = await until(() => nb.lens.present, 10_000).catch(() => false);
    if (!lens) {
      console.log("pi-marimo e2e: no Lens mounted in this marimo; the mark part was skipped");
      return;
    }
    const label = await markCell(f, doubled, "why 14?");
    const selection = nb.lens.selections().find((s) => s.label === label);
    expect(selection).toMatchObject({ note: "why 14?", cells: [doubled.id] });
    await unmarkSelection(f, selection!.id);
    await until(() => !nb.lens.selections().some((s) => s.id === selection!.id));
  } finally {
    await watcher.stop();
  }
}, 120_000);
