// Servers that run but have their notebook open in no browser: found through the server's file
// listing, scoped like followed notebooks, shown in the footer as a `not open` line whose name is
// an OSC 8 link to the notebook, and opened with /marimo open.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Cancellable, Io, StreamEnd } from "../src/core/io.js";
import { waitingNotebook } from "../src/core/registry.js";
import { MarimoWatcher, type Mode } from "../src/core/watcher.js";
import { waitingStatus, waitingUrl } from "../src/waiting.js";

type Server = { port: number; sessions?: Record<string, { path: string }>; files?: unknown[]; base?: string };

/** A fake marimo host: the registry's servers, their sessions, and what their home page lists. */
const hosted = vi.hoisted(() => ({ servers: [] as Server[], posts: [] as string[] }));

function fakeIo(): Io {
  const find = (url: string) => hosted.servers.find((s) => url.startsWith(`http://127.0.0.1:${s.port}${s.base ?? ""}/api/`));
  return {
    registryEntries: async () => hosted.servers.map((s) => ({ port: s.port, host: "127.0.0.1", base_url: s.base ?? "" })),
    getJson: async (url: string) => (url.endsWith("/api/sessions") ? find(url)?.sessions ?? {} : undefined),
    postJson: async (url: string) => {
      hosted.posts.push(url);
      const files = find(url)?.files;
      return files ? { root: "", files, hasMore: false } : undefined;
    },
    stream: (): Cancellable<StreamEnd> => ({ done: new Promise(() => undefined), cancel: () => undefined }),
    realpath: async (p: string) => p,
    sleep(ms: number): Cancellable<void> {
      let t: ReturnType<typeof setTimeout> | undefined;
      let wake!: () => void;
      const done = new Promise<void>((r) => { wake = r; t = setTimeout(r, ms); });
      return { done, cancel: () => { clearTimeout(t); wake(); } };
    },
  };
}

const file = (path: string, extra: object = {}) => ({ id: path, path, name: path, isDirectory: false, isMarimoFile: true, children: [], ...extra });

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const watchers: MarimoWatcher[] = [];
async function watch(mode: Mode, cwd = "/w"): Promise<MarimoWatcher> {
  const w = new MarimoWatcher({ io: fakeIo(), cwd, pollMs: 50, onChange: () => undefined });
  w.mode = mode;
  watchers.push(w);
  w.start();
  await w.settle(2000);
  return w;
}
afterEach(async () => {
  hosted.servers = [];
  hosted.posts = [];
  await Promise.all(watchers.splice(0).map((w) => w.stop()));
});

describe("waitingNotebook", () => {
  test("names the one file a server lists", async () => {
    hosted.servers = [{ port: 2718, files: [file("/w/nb.py")] }];
    expect(await waitingNotebook(fakeIo(), "http://127.0.0.1:2718")).toEqual({ url: "http://127.0.0.1:2718", path: "/w/nb.py" });
  });

  test("a directory, several files, a non-notebook, a failure or a host without POST name nothing", async () => {
    const io = fakeIo();
    hosted.servers = [
      { port: 1, files: [file("/w/a.py"), file("/w/b.py")] },
      { port: 2, files: [file("/w/dir", { isDirectory: true })] },
      { port: 3, files: [file("/w/x.py", { isMarimoFile: false })] },
      { port: 4 },
    ];
    for (const port of [1, 2, 3, 4]) expect(await waitingNotebook(io, `http://127.0.0.1:${port}`)).toBeUndefined();
    const { postJson: _postJson, ...noPost } = io;
    expect(await waitingNotebook(noPost, "http://127.0.0.1:1")).toBeUndefined();
  });
});

describe("the watcher's waiting servers", () => {
  test("auto: idle servers serving a notebook under the cwd, in file order; not other directories, hidden ones, or servers with a session", async () => {
    hosted.servers = [
      { port: 2719, files: [file("/w/b.py")] },
      { port: 2718, files: [file("/w/a.py")] },
      { port: 2720, files: [file("/elsewhere/c.py")] },
      { port: 2721, files: [file("/w/.worktrees/x/d.py")] },
      { port: 2722, files: [file("/w/e.py")], sessions: { s1: { path: "/w/e.py" } } },
    ];
    const w = await watch({ kind: "auto" });
    await until(() => w.waiting().length === 2);
    expect(w.waiting().map((x) => [x.url, x.path])).toEqual([["http://127.0.0.1:2718", "/w/a.py"], ["http://127.0.0.1:2719", "/w/b.py"]]);
    // The open notebook is followed, not waiting.
    expect(w.followed().map((f) => f.attachment.path)).toEqual(["/w/e.py"]);
  });

  test("pinned: only the pinned notebook; off: none; a notebook opened in a browser stops waiting", async () => {
    hosted.servers = [{ port: 2718, files: [file("/w/a.py")] }, { port: 2719, files: [file("/w/b.py")] }];
    const w = await watch({ kind: "pinned", paths: ["/w/b.py"] });
    await until(() => w.waiting().length === 1);
    expect(w.waiting()[0]).toMatchObject({ path: "/w/b.py", pinned: "/w/b.py" });
    w.setMode({ kind: "off" });
    await until(() => w.waiting().length === 0);
    w.setMode({ kind: "auto" });
    await until(() => w.waiting().length === 2);
    hosted.servers[0]!.sessions = { s1: { path: "/w/a.py" } };
    w.refresh();
    await until(() => w.waiting().length === 1);
    expect(w.waiting()[0]!.path).toBe("/w/b.py");
  });
});

describe("the footer line", () => {
  const w = { url: "http://127.0.0.1:2718", path: "/w/nb.py", canonicalPath: "/w/nb.py" };

  test("keeps the status shape and links the notebook's name to the server", () => {
    const linked = waitingStatus(w, true);
    expect(linked).toBe("marimo: \x1b]8;;http://127.0.0.1:2718/\x1b\\nb.py\x1b]8;;\x1b\\ · :2718 · not open");
    // Without links the text is the plain shape pi-status-footer and other footers parse.
    expect(waitingStatus(w, false)).toBe("marimo: nb.py · :2718 · not open");
    expect(waitingUrl(w)).toBe("http://127.0.0.1:2718/");
  });
});
