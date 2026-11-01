#!/usr/bin/env node
// Plain Node entry point. Use the installed host and its jiti, never a Pi chat session.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function findPiPackage() {
  // npm scripts prepend the repository's dev SDK: it is not the user's active installed Pi.
  const bins = execFileSync("which", ["-a", "pi"], { encoding: "utf8" }).split("\n")
    .filter((bin) => bin && !bin.includes("node_modules"));
  if (!bins[0]) throw new Error("pi is not on PATH; set PI_PACKAGE_DIR");
  const bin = realpathSync(bins[0]);
  let dir = path.dirname(bin);
  while (dir !== path.dirname(dir)) {
    for (const candidate of [dir, path.join(dir, "libexec", "lib", "node_modules", "@earendil-works", "pi-coding-agent")]) {
      if (path.basename(candidate) === "pi-coding-agent" && existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    dir = path.dirname(dir);
  }
  throw new Error("cannot find the installed pi-coding-agent package; set PI_PACKAGE_DIR");
}

async function main() {
  if (process.argv.length > 2 || process.stdin.isTTY) {
    process.stderr.write("system1: takes no arguments; pass a JSON request on stdin\n");
    return 2;
  }
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let request;
  try { request = JSON.parse(input); } catch {
    process.stderr.write("system1: stdin is not valid JSON\n");
    return 2;
  }
  const dir = path.resolve(process.env.PI_PACKAGE_DIR || findPiPackage());
  const entry = path.join(dir, "dist", "index.js");
  const requireHost = createRequire(path.join(dir, "package.json"));
  const { createJiti } = await import(pathToFileURL(requireHost.resolve("jiti")).href);
  const hostJiti = createJiti(entry, { interopDefault: true });
  const alias = {};
  // Each public path is resolved from the installed SDK, not from this component's dev tree.
  // Explicit subpath aliases also avoid appending provider paths to the root index.js alias.
  for (const specifier of ["@earendil-works/pi-ai/providers/openai", "@earendil-works/pi-ai/api/openai-decisions", "@earendil-works/pi-ai"]) {
    try { alias[specifier] = fileURLToPath(hostJiti.esmResolve(specifier)); } catch {
      // No accidental dev-SDK fallback on older installed hosts. The optional provider factory
      // handles missing native APIs and leaves Jev usable.
      alias[specifier] = path.join(dir, ".unsupported-system1-api", specifier.replaceAll("/", "_"));
    }
  }
  const jiti = createJiti(entry, { interopDefault: true, alias });
  const { runCli, validateCliRequest } = await jiti.import(fileURLToPath(new URL("../src/cli.ts", import.meta.url)));
  const invalid = validateCliRequest(request);
  if (invalid) {
    process.stdout.write(invalid.stdout);
    process.stderr.write(invalid.stderr);
    return invalid.exitCode;
  }
  const { ModelRuntime, ModelRegistry } = await import(pathToFileURL(entry).href);
  const registry = new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false }));
  const result = await runCli(request, registry);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.exitCode;
}

try {
  process.exitCode = await main();
} catch {
  // Never print raw SDK/auth/provider exceptions (which can contain keys or provider bodies).
  process.stderr.write("system1: installed Pi bootstrap failed; update Pi/pi-system1 or set PI_PACKAGE_DIR to the installed SDK\n");
  process.exitCode = 1;
}
