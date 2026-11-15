import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const suiteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

try {
  if (process.argv.slice(2).length) throw new Error("No flags supported; use SWITCHYARD_DIR to select a checkout");
  const coreDir = realpathSync(process.env.SWITCHYARD_DIR || resolve(suiteDir, "../switchyard"));
  const ci = !!process.env.CI && process.env.CI !== "false";
  const pin = JSON.parse(readFileSync(resolve(suiteDir, ".github/compat-switchyard.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(pin.commit) || typeof pin.version !== "string") throw new Error("Expected immutable Switchyard pin");
  if (realpathSync(git(coreDir, "rev-parse", "--show-toplevel")) !== coreDir) throw new Error("SWITCHYARD_DIR must be a repository root");
  if (ci) {
    for (const dir of [suiteDir, coreDir]) {
      if (git(dir, "status", "--porcelain", "--untracked-files=normal")) throw new Error(`CI requires a clean checkout: ${dir}`);
    }
    const version = JSON.parse(readFileSync(resolve(coreDir, "package.json"), "utf8")).version;
    if (git(coreDir, "rev-parse", "HEAD") !== pin.commit || version !== pin.version) throw new Error("Switchyard does not match compat-switchyard.json");
  }
  realpathSync(resolve(coreDir, "packages/adapter-sdk/dist/index.js"));
  const pkg = JSON.parse(readFileSync(resolve(coreDir, "package.json"), "utf8"));
  if (!pkg.scripts?.["test:plugins"]) throw new Error("Switchyard must provide test:plugins; update the core pin after publishing the compatibility harness");
  console.log(`Switchyard reverse compatibility: ${coreDir} @ ${git(coreDir, "rev-parse", "HEAD")}; suite ${suiteDir} @ ${git(suiteDir, "rev-parse", "HEAD")}`);
  // npm prepends this suite's loader-test Pi (currently 1.2) to PATH. It is not the
  // selected compatibility runtime. Keep an explicit override, otherwise resolve the
  // normal PATH binary without npm's local dependency bins before invoking pnpm.
  const runtimePath = (process.env.PATH || "").split(delimiter)
    .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(entry)).join(delimiter);
  const selectedPi = process.env.SWITCHYARD_PI_BIN || realpathSync(execFileSync("which", ["pi"], {
    encoding: "utf8", env: { ...process.env, PATH: runtimePath },
  }).trim());
  const result = spawnSync("pnpm", ["test:plugins", "--current-suite", ...(ci ? [] : ["--allow-dirty"])], {
    cwd: coreDir,
    env: { ...process.env, SWITCHYARD_PI_BIN: selectedPi, SWITCHYARD_PI_PLUGINS_DIR: suiteDir, SWITCHYARD_REQUIRE_PI_PLUGINS: "1" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Switchyard compatibility: ${error.message}`);
  process.exitCode = 1;
}
