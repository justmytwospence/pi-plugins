// Auto mode's scope: notebooks under the cwd, outside hidden directories and other Git repositories below it.
import { expect, test } from "vitest";
import type { Cancellable, Io, StreamEnd } from "../src/core/io.js";
import { MarimoWatcher } from "../src/core/watcher.js";

function io(paths: string[], repos: string[]): Io {
  return {
    registryEntries: async () => [{ port: 2799, host: "127.0.0.1" }],
    getJson: async (url: string) => (url.endsWith("/api/sessions") ? Object.fromEntries(paths.map((path, i) => [`s${i}`, { path }])) : undefined),
    stream: (): Cancellable<StreamEnd> => { let end!: (e: StreamEnd) => void; return { done: new Promise((r) => (end = r)), cancel: () => end({ ok: true }) }; },
    exists: async (p: string) => repos.some((r) => p === `${r}/.git`),
    realpath: async (p: string) => p,
    sleep: (ms: number): Cancellable<void> => { let t: ReturnType<typeof setTimeout>; let wake!: () => void; const done = new Promise<void>((r) => { wake = r; t = setTimeout(r, ms); }); return { done, cancel: () => { clearTimeout(t); wake(); } }; },
  };
}

async function followed(cwd: string, paths: string[], repos: string[]): Promise<string[]> {
  const w = new MarimoWatcher({ io: io(paths, repos), cwd, pollMs: 60_000, onChange: () => undefined });
  w.start();
  await w.settle(2000);
  const out = w.followed().map((f) => f.attachment.path).sort();
  await w.stop();
  return out;
}

test("started in a directory of projects, notebooks in the projects' repositories are not followed", async () => {
  const paths = ["/p/scratch.py", "/p/alpha/nb.py", "/p/alpha/sub/deep.py", "/p/beta/notebooks/fit.py", "/p/.hidden/x.py"];
  expect(await followed("/p", paths, ["/p/alpha", "/p/beta"])).toEqual(["/p/scratch.py"]);
  // Inside one repository, its own notebooks are, a nested repository's (a submodule) are not.
  expect(await followed("/p/alpha", paths, ["/p/alpha", "/p/alpha/sub"])).toEqual(["/p/alpha/nb.py"]);
});
