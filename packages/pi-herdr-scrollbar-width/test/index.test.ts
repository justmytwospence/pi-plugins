import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { installWidthGuard } from "../src/index.ts";

const ENTER = "\x1b[?1049h";
const EXIT = "\x1b[?1049l";

function output(columns = 100) {
  const calls: { receiver: unknown; chunk: unknown; rest: unknown[]; columns: number }[] = [];
  const out = {
    columns,
    write: function (this: unknown, chunk: unknown, ...rest: unknown[]) {
      calls.push({ receiver: this, chunk, rest, columns: out.columns });
      const callback = rest.find((value) => typeof value === "function") as (() => void) | undefined;
      callback?.();
      return false;
    } as NodeJS.WriteStream["write"],
  };
  return { out, calls };
}

test("strings, Buffers, and every split boundary preserve write semantics", () => {
  for (const buffered of [false, true]) {
    for (let split = 0; split <= EXIT.length; split++) {
      const { out, calls } = output();
      const original = out.write;
      const release = installWidthGuard(out);
      const encode = (value: string) => buffered ? Buffer.from(value) : value;
      const first = encode(EXIT.slice(0, split));
      const last = encode(EXIT.slice(split));
      let callbacks = 0;
      assert.equal(out.write(first), false);
      assert.equal(out.write(last, "utf8", () => callbacks++), false);
      assert.equal(out.columns, 99);
      assert.equal(callbacks, 1);
      assert.equal(calls[1].receiver, out);
      assert.equal(calls[0].chunk, first);
      assert.equal(calls[1].chunk, last);
      assert.equal(calls[1].columns, 99);
      release();
      assert.equal(out.write, original);
    }
  }
});

test("duplicate exits and narrow panes are not narrowed twice", () => {
  for (const columns of [4, 5, 100]) {
    const { out } = output(columns);
    const release = installWidthGuard(out);
    out.write(EXIT + EXIT);
    assert.equal(out.columns, columns > 4 ? columns - 1 : columns);
    release();
  }
});

test("multiple transitions are processed in order, and main-screen SIGWINCH is harmless", () => {
  const { out } = output();
  const release = installWidthGuard(out);
  out.write(EXIT + ENTER);
  assert.equal(out.columns, 99);
  out.columns = 100; // Herdr's wider alternate-screen resize.
  out.write(EXIT);
  assert.equal(out.columns, 99);
  out.columns = 99; // The later main-screen resize agrees with the fix.
  out.write(EXIT);
  assert.equal(out.columns, 99);
  release();
});

test("signal-style shutdown retains the fix until the actual final alt-screen exit", () => {
  const { out } = output();
  const original = out.write;
  const release = installWidthGuard(out);
  release(); // session_shutdown precedes terminal stop on signal shutdown.
  release();
  assert.notEqual(out.write, original);
  out.write(Buffer.from(EXIT.slice(0, 4)));
  assert.notEqual(out.write, original);
  out.write(Buffer.from(EXIT.slice(4)));
  assert.equal(out.columns, 99);
  assert.equal(out.write, original);
  out.write("final transcript");
  assert.equal(out.columns, 99);
});

test("shutdown after terminal stop restores immediately; reload leases remain owned", () => {
  const { out } = output();
  const original = out.write;
  const old = installWidthGuard(out);
  const current = installWidthGuard(out);
  old();
  out.write(EXIT);
  assert.notEqual(out.write, original);
  current();
  assert.equal(out.write, original);

  const retiring = installWidthGuard(out);
  retiring();
  const reload = installWidthGuard(out);
  out.write(EXIT);
  assert.notEqual(out.write, original);
  reload();
  assert.equal(out.write, original);
});

test("restoration preserves later wrappers and makes retained delegates inert", () => {
  const { out } = output();
  const release = installWidthGuard(out);
  const delegated = out.write;
  const later = function (this: typeof out, ...args: unknown[]) {
    return (delegated as (...args: unknown[]) => boolean).apply(this, args);
  } as typeof out.write;
  out.write = later;
  release();
  out.write(EXIT);
  assert.equal(out.write, later);
  assert.equal(out.columns, 99);
  out.write(ENTER + EXIT);
  assert.equal(out.columns, 99);
});

test("the extension's real stdout patch survives shutdown before terminal exit", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from 'node:assert/strict';
    import extension from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
    process.env.HERDR_ENV = '1';
    process.env.HERDR_CONFIG_PATH = '/nonexistent/herdr-scrollbar-test.toml';
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.stdout.columns = 100;
    const original = process.stdout.write;
    const handlers = new Map();
    extension({ on: (name, handler) => handlers.set(name, handler) });
    handlers.get('session_start')({}, { mode: 'tui' });
    handlers.get('session_shutdown')();
    assert.notEqual(process.stdout.write, original);
    process.stdout.write(Buffer.from('\\x1b[?1049'));
    process.stdout.write(Buffer.from('l'));
    assert.equal(process.stdout.columns, 99);
    assert.equal(process.stdout.write, original);
    process.stdout.write('final transcript\\n');
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, EXIT + "final transcript\n");
});

test("factory and headless session load do not patch process stdout", () => {
  const original = process.stdout.write;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  extension({ on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  assert.equal(process.stdout.write, original);
  handlers.get("session_start")!({}, { mode: "rpc" });
  assert.equal(process.stdout.write, original);
  handlers.get("session_shutdown")!();
  assert.equal(process.stdout.write, original);
});
