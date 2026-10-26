import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test.skipIf(process.platform !== "darwin")("postinstall repairs only the packaged macOS helper and is idempotent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-pty-install-"));
  const dir = path.join(root, "node_modules/node-pty");
  const binary = path.join(dir, `prebuilds/darwin-${process.arch}/spawn-helper`);
  const other = path.join(dir, "unrelated-file");
  try {
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), '{"name":"node-pty","version":"1.1.0"}');
    writeFileSync(binary, "fixture"); chmodSync(binary, 0o644);
    writeFileSync(other, "fixture"); chmodSync(other, 0o644);
    const script = fileURLToPath(new URL("../scripts/prepare-pty.cjs", import.meta.url));
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(statSync(binary).mode & 0o777).toBe(0o755);
      expect(statSync(other).mode & 0o777).toBe(0o644);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
