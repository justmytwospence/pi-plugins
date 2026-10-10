// Against a real marimo server: needs `marimo` on PATH (skipped otherwise).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { nodeIo } from "../src/core/node-io.js";
import { MarimoWatcher } from "../src/core/watcher.js";

const hasMarimo = (() => {
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
    import time
    return mo, time


@app.cell
def _(mo):
    mo.md("""
    # Loading
    """)
    return


@app.cell
def _(mo):
    mo.md("""
    ## Slow step
    """)
    return


@app.cell
def _(time):
    time.sleep(3)
    y = 1
    return (y,)


if __name__ == "__main__":
    app.run()
`;

const port = 27300 + Math.floor(Math.random() * 500);
let server: ChildProcess | undefined;
const aborts: AbortController[] = [];
afterAll(() => {
  for (const a of aborts) a.abort();
  server?.kill();
});

async function until<T>(check: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function openInBrowser(url: string, file: string, id: string): void {
  // Stand in for the browser: the main consumer that creates the session.
  const browser = new AbortController();
  aborts.push(browser);
  void fetch(`${url}/sse?session_id=${id}&file=${encodeURIComponent(file)}`, { signal: browser.signal })
    .then(async (r) => { for await (const _ of r.body!) { /* drain */ } })
    .catch(() => undefined);
}

function runAll(url: string, file: string): void {
  const run = spawn("marimo", ["pair", "execute", "--url", url, "--file", file, "--code-file", "-"], { stdio: ["pipe", "ignore", "ignore"] });
  run.stdin!.end("import marimo._code_mode as cm\nasync with cm.get_context() as ctx:\n    for c in ctx.cells:\n        ctx.run_cell(c.id)\n");
}

test.skipIf(!hasMarimo)("follows the notebooks open under the cwd, the most recently used one current", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-marimo-")));
  const file = join(dir, "nb.py");
  const other = join(dir, "other.py");
  const hidden = join(dir, ".worktrees", "branch", "nb.py");
  writeFileSync(file, NOTEBOOK);
  writeFileSync(other, NOTEBOOK.replace("## Slow step", "## Other step"));
  mkdirSync(join(dir, ".worktrees", "branch"), { recursive: true });
  writeFileSync(hidden, NOTEBOOK);
  server = spawn("marimo", ["edit", dir, "--no-token", "--headless", "--port", String(port)], { cwd: dir, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  openInBrowser(url, file, "browser1");
  openInBrowser(url, other, "browser2");
  openInBrowser(url, hidden, "browser3");

  let changes = 0;
  const watcher = new MarimoWatcher({ io: nodeIo(), cwd: dir, pollMs: 300, onChange: () => changes++ });
  watcher.start();
  try {
    await until(() => watcher.connection === "connected" && watcher.others().length === 1);
    // The checkout under a hidden directory is left out.
    expect([watcher.attachment!.path, ...watcher.others().map((o) => o.path)].sort()).toEqual([file, other]);
    expect(watcher.notebook.order).toHaveLength(4);

    runAll(url, file);
    const running = await until(() => {
      const r = watcher.notebook.running();
      return r?.section.length === 2 ? r : undefined;
    });
    expect(watcher.attachment?.path).toBe(file);
    expect(running.section).toEqual(["Loading", "Slow step"]);
    await until(() => watcher.notebook.defs.get(running.cell.id)?.includes("y") && !watcher.notebook.running());
    expect(changes).toBeGreaterThan(3);

    // Running the other notebook makes it current.
    runAll(url, other);
    await until(() => watcher.attachment?.path === other && watcher.notebook.running()?.section.join() === "Loading,Other step");
    await until(() => !watcher.notebook.running());

    // An edit typed in the browser reaches us (marimo does not echo it to the
    // browser's own id), and makes its notebook current again.
    expect(watcher.seesBrowserEdits).toBe(true);
    const html = await (await fetch(`${url}/?file=${encodeURIComponent(file)}`)).text();
    const serverToken = /marimo-server-token data-token="([^"]+)"/.exec(html)![1];
    const edit = await fetch(`${url}/api/document/transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Marimo-Session-Id": "browser1", "Marimo-Server-Token": serverToken },
      body: JSON.stringify({ changes: [{ type: "set-code", cellId: running.cell.id, code: "time.sleep(3)\ny = 2" }] }),
    });
    expect(edit.ok).toBe(true);
    const cell = await until(() => watcher.attachment?.path === file && watcher.notebook.cells.get(running.cell.id)?.editedBy === "frontend" && watcher.notebook.cells.get(running.cell.id));
    expect(watcher.notebook.edited(cell)).toBe(true);

    // This session's agent working in other.py keeps it current, even while the user runs fit.py.
    expect(watcher.touch([{ url: url.replace("127.0.0.1", "localhost"), file: "other.py" }])).toBe(true);
    expect(watcher.attachment?.path).toBe(other);
    runAll(url, file);
    await until(() => watcher.followed().find((f) => f.attachment.path === file)?.notebook.running());
    expect(watcher.attachment?.path).toBe(other);
    await until(() => !watcher.followed().some((f) => f.notebook.running()));
    // By session id too; a target matching nothing changes nothing.
    expect(watcher.touch([{ url, session: "browser1" }])).toBe(true);
    expect(watcher.attachment?.path).toBe(file);
    expect(watcher.touch([{ url, file: "missing.py" }])).toBe(false);

    // Pinning follows exactly the pinned notebooks, the hidden one included.
    watcher.setMode({ kind: "pinned", paths: [other, hidden] });
    const paths = () => watcher.followed().map((f) => f.attachment.path).sort().join();
    await until(() => paths() === [hidden, other].sort().join() && watcher.followed().every((f) => f.connection === "connected"));
  } finally {
    await watcher.stop();
  }
});
