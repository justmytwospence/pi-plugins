import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Headroom, SAMPLE_MS, type HeadroomOptions } from "./headroom.ts";

export interface Claim {
  /** Duplicate into the job's descriptor 3; do not close or unlock it directly. */
  fd: number;
  releaseAdmission(): void;
  releaseSlot(): void;
}

export interface AdmissionOptions {
  directory?: string;
  /** Return false only for contention; throw for backend errors. */
  lock?: (fd: number, signal: AbortSignal) => boolean | Promise<boolean>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Source of contention jitter, in [0, 1). */
  random?: () => number;
  now?: () => number;
  headroom?: HeadroomOptions;
}

type Location = { base: string; privateBase?: boolean; parts: string[] };

function defaultLocation(): Location {
  if (process.platform === "darwin") {
    return { base: os.homedir(), parts: ["Library", "Caches", "pi-bg", "admission-v1"] };
  }
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return { base: runtime, privateBase: true, parts: ["pi-bg", "admission-v1"] };
  const host = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
  return { base: os.homedir(), parts: [".cache", "pi-bg", "admission-v1", host] };
}

function checkedDirectory(directory: string, uid: number, privateMode: boolean): void {
  const stat = fs.lstatSync(directory);
  const mode = stat.mode & 0o7777;
  // Root-owned sticky ancestors (e.g. /tmp) cannot have our entries replaced by another user.
  const safe = privateMode ? stat.uid === uid && mode === 0o700
    : (stat.uid === uid || stat.uid === 0) && (!(mode & 0o022) || (stat.uid === 0 && !!(mode & 0o1000)));
  if (!stat.isDirectory() || !safe) {
    throw new Error(`Unsafe heavy-job admission directory (symlink, owner, or permissions): ${directory}`);
  }
}

function prepareDirectory(override: string | undefined, uid: number): string {
  if (override !== undefined && !path.isAbsolute(override)) throw new Error("Heavy-job admission directory must be absolute");
  const target = override === undefined ? undefined : path.resolve(override);
  const { base, parts, privateBase } = target === undefined ? defaultLocation() : {
    base: path.dirname(target), parts: [path.basename(target)], privateBase: false,
  };
  if (!path.isAbsolute(base)) throw new Error("Heavy-job admission directory must be absolute");
  const resolved = path.resolve(base);
  let directory = path.parse(resolved).root;
  const ancestors = resolved.slice(directory.length).split(path.sep).filter(Boolean);
  checkedDirectory(directory, uid, !!privateBase && ancestors.length === 0);
  for (const [i, part] of ancestors.entries()) {
    directory = path.join(directory, part);
    checkedDirectory(directory, uid, !!privateBase && i === ancestors.length - 1);
  }
  let privateMode = target !== undefined;
  for (const part of parts) {
    directory = path.join(directory, part);
    privateMode ||= part === "pi-bg";
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    checkedDirectory(directory, uid, privateMode);
  }
  return directory;
}

interface OpenFile { fd: number; close(): void }

function openPrivate(directory: string, name: string, uid: number): OpenFile {
  const file = path.join(directory, name);
  const { O_CREAT, O_RDWR, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(file, O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK, 0o600);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    fs.closeSync(fd);
  };
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) {
      throw new Error(`Unsafe heavy-job admission file: ${file}`);
    }
    return { fd, close };
  } catch (error) {
    close();
    throw error;
  }
}

function nativeLock(): NonNullable<AdmissionOptions["lock"]> {
  const darwin = process.platform === "darwin";
  if (!darwin && process.platform !== "linux") throw new Error("Heavy-job admission needs macOS lockf or Linux util-linux flock");
  const command = darwin ? "/usr/bin/lockf" : fs.existsSync("/usr/bin/flock") ? "/usr/bin/flock" : "/bin/flock";
  const args = darwin ? ["-s", "-t", "0", "3"] : ["-n", "-E", "75", "3"];
  return (fd, signal) => new Promise<boolean>((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "ignore", fd], signal, killSignal: "SIGKILL" });
    let failure: Error | undefined;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 2_000);
    child.on("error", (error) => { failure = error; });
    child.once("close", (code, killedBy) => {
      clearTimeout(timer);
      // Wait for close before unwinding: a cancelled helper must no longer own a duplicate fd.
      if (signal.aborted) return reject(signal.reason);
      if (!timedOut && !failure && (code === 0 || code === 75)) return resolve(code === 0);
      const detail = timedOut ? "timed out" : failure?.message ?? (killedBy ? `killed by ${killedBy}` : `exit ${code}`);
      reject(new Error(`Heavy-job admission lock backend (${command}) failed: ${detail}`));
    });
  });
}

async function tryLock(directory: string, name: string, uid: number, lock: NonNullable<AdmissionOptions["lock"]>, signal: AbortSignal) {
  signal.throwIfAborted();
  const file = openPrivate(directory, name, uid);
  let granted = false;
  try {
    const acquired = await lock(file.fd, signal);
    signal.throwIfAborted();
    granted = acquired;
    if (granted) return file;
  } finally {
    if (!granted) file.close();
  }
}

function writeTimestamp(fd: number, now: number): void {
  fs.ftruncateSync(fd, 0); // This file is not a lock file; callers hold the admission lock.
  const text = `${now}\n`;
  if (fs.writeSync(fd, text, 0, "utf8") !== text.length) throw new Error("Incomplete heavy-job admission timestamp");
}

function admissionAge(fd: number, now: number): number {
  const bytes = Buffer.alloc(32);
  const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
  const text = bytes.toString("utf8", 0, size);
  const last = Number(text);
  if (Number.isSafeInteger(last) && last >= 0 && last <= now && text === `${last}\n`) return now - last;
  writeTimestamp(fd, now);
  return 0;
}

const CONTENTION_MS = 500;
const CONTENTION_JITTER_MS = 100;
type Attempt = Claim | { reason: string; waitMs: number };

/** Coordinates opt-in finite jobs, with kernel lock lifetimes owned by open descriptors. */
export class Admission {
  readonly #options: AdmissionOptions;

  constructor(options: AdmissionOptions = {}) {
    this.#options = options;
  }

  async acquire(signal: AbortSignal, onReason: (reason: string) => void): Promise<Claim> {
    signal.throwIfAborted();
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Heavy-job admission requires Unix file ownership and locks");
    const { directory, lock = nativeLock(), wait = (ms, signal) => delay(ms, undefined, { signal }), headroom } = this.#options;
    const dir = prepareDirectory(directory, uid);
    const policy = new Headroom(headroom);
    let reason: string | undefined;
    for (;;) {
      const attempt = await this.#attempt(dir, uid, lock, policy, signal);
      if ("fd" in attempt) {
        if (signal.aborted) {
          try { attempt.releaseSlot(); } finally { attempt.releaseAdmission(); }
          signal.throwIfAborted();
        }
        return attempt;
      }
      signal.throwIfAborted();
      if (attempt.reason !== reason) onReason(reason = attempt.reason);
      signal.throwIfAborted();
      await wait(attempt.waitMs, signal);
    }
  }

  async #attempt(dir: string, uid: number, lock: NonNullable<AdmissionOptions["lock"]>, policy: Headroom, signal: AbortSignal): Promise<Attempt> {
    const admission = await tryLock(dir, "admission.lock", uid, lock, signal);
    if (!admission) {
      // The short lock usually clears quickly. Spread retries across sessions.
      const random = this.#options.random ?? Math.random;
      const jitter = Math.floor(random() * (2 * CONTENTION_JITTER_MS + 1)) - CONTENTION_JITTER_MS;
      return { reason: "waiting for host admission", waitMs: CONTENTION_MS + jitter };
    }
    let slot: OpenFile | undefined;
    let timestamp: OpenFile | undefined;
    let handedOff = false;
    try {
      let occupied = 0;
      for (const name of ["slot-1.lock", "slot-2.lock"]) {
        const probe = await tryLock(dir, name, uid, lock, signal);
        if (!probe) occupied++;
        else if (slot) probe.close();
        else slot = probe;
      }
      // Full slots are likely to stay full, so check at the slower sampling cadence
      // without actually sampling; never keep admission locked while waiting.
      if (!slot) return { reason: "both heavy-job slots are occupied", waitMs: SAMPLE_MS };

      await policy.sample(signal);
      signal.throwIfAborted();
      const now = (this.#options.now ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid heavy-job admission clock");
      if (occupied === 1) timestamp = openPrivate(dir, "last-admission", uid);
      const age = timestamp ? admissionAge(timestamp.fd, now) : 0;
      const reason = policy.blockedReason(occupied, age);
      if (reason) return { reason, waitMs: SAMPLE_MS };
      timestamp ??= openPrivate(dir, "last-admission", uid);
      writeTimestamp(timestamp.fd, now);
      timestamp.close();
      handedOff = true;
      return { fd: slot.fd, releaseAdmission: admission.close, releaseSlot: slot.close };
    } finally {
      try { timestamp?.close(); }
      finally {
        if (!handedOff) {
          try { slot?.close(); } finally { admission.close(); }
        }
      }
    }
  }
}
