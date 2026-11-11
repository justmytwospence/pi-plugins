import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

// A plain Node process proves there are no Vitest mocks masking import-time work.
// Module-loader reads are not quota I/O; instrument the actual config/cache,
// transport and process entry points used by the library.
test("import and idle/message/turn activity schedule no quota work or side effects", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import fsp from "node:fs/promises";
    import cp from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { fileURLToPath } from "node:url";
    const calls = [];
    const forbidden = name => () => { calls.push(name); throw new Error(name); };
    const idle = globalThis.setTimeout;
    for (const name of ["fetch", "setTimeout", "setInterval"])
      globalThis[name] = forbidden(name);
    // Node 26's ESM loader reads module sources with fs.readFileSync: let it load this package's
    // own sources and dependencies, and forbid every other read (config, cache, auth files).
    const src = ${JSON.stringify(fileURLToPath(new URL("../src/", import.meta.url)))};
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => {
      const path = file instanceof URL ? fileURLToPath(file) : String(file);
      if (path.startsWith(src) || path.includes("/node_modules/")) return read(file, ...rest);
      return forbidden("config read")();
    };
    for (const name of ["mkdir", "open", "lstat", "realpath", "rename", "unlink", "rmdir"])
      fsp[name] = forbidden("cache " + name);
    cp.spawn = forbidden("spawn");
    syncBuiltinESMExports();
    const usage = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});
    assert.equal(typeof usage.readSelectionPressure, "function");
    assert.equal(usage.default, undefined); // library, not an event-registering extension
    const host = new EventTarget();
    for (const type of ["input", "before_agent_start", "message", "turn_start", "turn_end", "model_select", "tool_result"])
      host.dispatchEvent(new Event(type));
    await new Promise(resolve => idle(resolve, 20));
    assert.deepEqual(calls, []);
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
