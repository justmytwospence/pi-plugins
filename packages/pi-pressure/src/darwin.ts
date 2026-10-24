// macOS memory pressure and thermal state without polling: a small Swift helper
// that blocks in dispatchMain until the kernel wakes it (a memory-pressure
// dispatch source; ProcessInfo's thermal-state notification) and prints one
// line per change. It prints both states at start, exits when its stdin
// closes (so it never outlives Pi), and costs nothing while nothing changes.
//
// The source ships here and is compiled once per version with the Xcode
// command line tools into ~/.cache/pi-pressure. Without them the sampler falls
// back to reading sysctl on Pi activity.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { run } from "./sample.ts";

export const SWIFT_SOURCE = `import Foundation
setvbuf(stdout, nil, _IOLBF, 0)
func memory() {
  var level: Int32 = 0
  var size = MemoryLayout<Int32>.size
  if sysctlbyname("kern.memorystatus_vm_pressure_level", &level, &size, nil, 0) == 0 { print("memory \\(level)") }
}
func thermal() { print("thermal \\(ProcessInfo.processInfo.thermalState.rawValue)") }
let pressure = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: .main)
pressure.setEventHandler { memory() }
pressure.resume()
let observer = NotificationCenter.default.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { _ in thermal() }
// Exit once the parent closes our stdin (it quit or died).
let input = DispatchSource.makeReadSource(fileDescriptor: 0, queue: .main)
input.setEventHandler { var buffer = [UInt8](repeating: 0, count: 64); if read(0, &buffer, 64) <= 0 { exit(0) } }
input.resume()
memory()
thermal()
dispatchMain()
`;

export type HelperLine = { memoryLevel: number } | { thermalState: number };

export function parseHelperLine(line: string): HelperLine | undefined {
  const memory = /^memory (\d+)$/.exec(line.trim());
  if (memory) return { memoryLevel: +memory[1] };
  const thermal = /^thermal (\d)$/.exec(line.trim());
  if (thermal) return { thermalState: +thermal[1] };
  return undefined;
}

const cacheDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-pressure");
export const helperPath = (dir = cacheDir()) => join(dir, `events-${createHash("sha256").update(SWIFT_SOURCE).digest("hex").slice(0, 12)}`);

let building: Promise<string | undefined> | undefined;

/** The compiled helper, building it on first use; undefined without the Swift compiler. */
export function ensureHelper(dir = cacheDir()): Promise<string | undefined> {
  const target = helperPath(dir);
  if (existsSync(target)) return Promise.resolve(target);
  building ??= (async () => {
    const work = await mkdtemp(join(tmpdir(), "pi-pressure-"));
    try {
      await mkdir(dir, { recursive: true });
      const source = join(work, "main.swift");
      const binary = join(work, "events");
      await writeFile(source, SWIFT_SOURCE);
      await run("xcrun", ["swiftc", "-O", "-o", binary, source], 120_000);
      // Atomic: concurrent Pi processes may build the same version.
      await rename(binary, target);
      return target;
    } catch {
      return existsSync(target) ? target : undefined;
    } finally {
      building = undefined;
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return building;
}

/** Starts the helper; `onLine` gets each state change, `onExit` when it stops for any reason. */
export function startHelper(binary: string, onLine: (line: HelperLine) => void, onExit: () => void): { stop(): void } {
  let child: ChildProcess | undefined = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    const parsed = parseHelperLine(line);
    if (parsed) onLine(parsed);
  });
  child.on("error", () => {});
  child.on("exit", () => { child = undefined; onExit(); });
  // Neither keeps Pi alive.
  child.unref();
  (child.stdout as unknown as { unref?: () => void }).unref?.();
  (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  return {
    stop() {
      const current = child;
      child = undefined;
      lines.close();
      if (!current) return;
      current.removeAllListeners("exit");
      current.stdin?.end();
      current.kill();
    },
  };
}
