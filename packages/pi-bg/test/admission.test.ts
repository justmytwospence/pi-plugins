import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { Admission, type AdmissionOptions, type Claim } from "../src/admission.ts";
import { COOLDOWN_MS, type HostReading } from "../src/headroom.ts";

const roots: string[] = [];
function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-bg-admit-"));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const files = ["admission.lock", "slot-1.lock", "slot-2.lock"] as const;
type LockName = typeof files[number];
const quiet = () => {};
const missing = () => ({});
function healthy(now: number): HostReading {
  return { cpu: { total: 10_000 + now, idle: 5_000 + now * 0.7 }, memory: { source: "darwin", level: 1 } };
}

function fake() {
  const directory = fixtureDir();
  let now = 100_000, waits = 0;
  const busy = new Set<LockName>();
  const opened = new Map<LockName, number>();
  const lock: NonNullable<AdmissionOptions["lock"]> = (fd) => {
    const { ino } = fs.fstatSync(fd);
    const name = files.find((name) => {
      try { return fs.statSync(path.join(directory, name)).ino === ino; } catch { return false; }
    })!;
    opened.set(name, fd);
    return !busy.has(name);
  };
  const options: AdmissionOptions = {
    directory, lock, now: () => now, headroom: { now: () => now, read: () => healthy(now) },
    wait: async (ms) => {
      if (++waits > 20) throw new Error("fake waiter did not settle");
      now += ms;
    },
  };
  return { directory, now: () => now, advance: (ms: number) => { now += ms; }, busy, opened, options };
}

function expectClosed(opened: Map<LockName, number>) {
  for (const fd of opened.values()) expect(() => fs.fstatSync(fd)).toThrow(/EBADF/);
}

function release(claim: Claim) {
  try { claim.releaseSlot(); } finally { claim.releaseAdmission(); }
}

describe("heavy-job admission", () => {
  it("checks both slots while holding admission, then transfers two independently releasable descriptors", async () => {
    const { options, opened, busy } = fake();
    const calls: LockName[] = [];
    const reasons: string[] = [];
    const controller = new AbortController();
    options.lock = ((lock) => (fd, signal) => {
      const result = lock!(fd, signal);
      const name = [...opened].filter(([, openedFd]) => openedFd === fd).at(-1)![0];
      calls.push(name);
      if (name !== "admission.lock") expect(fs.fstatSync(opened.get("admission.lock")!).isFile()).toBe(true);
      return result;
    })(options.lock);
    options.headroom = { read: () => {
      expect(fs.fstatSync(opened.get("admission.lock")!).isFile()).toBe(true);
      return {};
    } };
    busy.add("admission.lock");
    options.random = () => 0.75;
    options.wait = async (ms) => {
      expect(ms).toBe(550);
      expectClosed(opened);
      busy.delete("admission.lock");
    };
    const claim = await new Admission(options).acquire(controller.signal, (reason) => reasons.push(reason));
    try {
      expect(calls).toEqual(["admission.lock", "admission.lock", "slot-1.lock", "slot-2.lock"]);
      expect(reasons).toEqual(["waiting for host admission"]);
      expect(claim.fd).toBe(opened.get("slot-1.lock"));
      expect(() => fs.fstatSync(opened.get("slot-2.lock")!)).toThrow(/EBADF/);
      controller.abort(); // After handoff the caller owns both releases.
      claim.releaseAdmission();
      claim.releaseAdmission();
      expect(() => fs.fstatSync(opened.get("admission.lock")!)).toThrow(/EBADF/);
      expect(fs.fstatSync(claim.fd).isFile()).toBe(true);
      claim.releaseSlot();
      claim.releaseSlot();
      expect(() => fs.fstatSync(claim.fd)).toThrow(/EBADF/);
    } finally { release(claim); }
  });

  it.each([undefined, "garbage\n", "99999999999999999\n", "100001\n", "1\n\n"])(
    "starts a fresh cooldown with an occupied slot and invalid timestamp %j", async (contents) => {
      const { options, directory, busy, now } = fake();
      busy.add("slot-1.lock");
      if (contents !== undefined) fs.writeFileSync(path.join(directory, "last-admission"), contents, { mode: 0o600 });
      const before = now();
      const reasons: string[] = [];
      const claim = await new Admission(options).acquire(AbortSignal.timeout(2_000), (reason) => reasons.push(reason));
      try {
        expect(now() - before).toBe(COOLDOWN_MS);
        expect(reasons).toEqual(["waiting for healthy host samples", "waiting for admission cooldown"]);
        expect(fs.readFileSync(path.join(directory, "last-admission"), "utf8")).toBe(`${now()}\n`);
      } finally { release(claim); }
    },
  );

  it("does not expand under pressure or sample when both slots are full; cancelling never hands off a claim", async () => {
    const { options, busy, opened, advance, now } = fake();
    const controller = new AbortController();
    const reasons: string[] = [];
    let samples = 0;
    busy.add("slot-1.lock");
    busy.add("slot-2.lock");
    options.headroom = { now: () => now(), read: () => {
      samples++;
      return { ...healthy(now()), memory: { source: "darwin", level: 2 } };
    } };
    options.wait = async (ms) => {
      expectClosed(opened);
      if (busy.has("slot-2.lock")) {
        expect(ms).toBe(2_000);
        expect(samples).toBe(0);
        busy.delete("slot-2.lock");
      }
      advance(ms);
    };
    const sentinel = new Error("cancelled");
    await expect(new Admission(options).acquire(controller.signal, (reason) => {
      reasons.push(reason);
      if (samples) controller.abort(sentinel);
    })).rejects.toBe(sentinel);
    expect(reasons).toEqual(["both heavy-job slots are occupied", "waiting for memory pressure to ease"]);
    expectClosed(opened);
  });

  it("fails closed on a backend error and closes all probes, including the candidate", async () => {
    const { options, opened } = fake();
    const lock = options.lock!;
    const error = new Error("lock helper exit 71");
    options.lock = (fd, signal) => {
      const result = lock(fd, signal);
      if (opened.has("slot-2.lock")) throw error;
      return result;
    };
    options.headroom = { read: () => { throw new Error("must not sample"); } };
    await expect(new Admission(options).acquire(AbortSignal.timeout(2_000), quiet)).rejects.toBe(error);
    expectClosed(opened);
    options.lock = lock;
    options.headroom = { read: missing };
    release(await new Admission(options).acquire(AbortSignal.timeout(2_000), quiet));
  });

  it("closes a candidate when aborted during a lock grant or the subsequent sample", async () => {
    for (const abortDuring of ["grant", "sample"]) {
      const { options, opened } = fake();
      const controller = new AbortController();
      const lock = options.lock!;
      options.lock = (fd, signal) => {
        const result = lock(fd, signal);
        if (abortDuring === "grant" && opened.has("slot-1.lock")) controller.abort();
        return result;
      };
      options.headroom = { read: () => { controller.abort(); return {}; } };
      await expect(new Admission(options).acquire(controller.signal, quiet)).rejects.toMatchObject({ name: "AbortError" });
      expectClosed(opened);
    }
  });

  it("rejects symlinks and unsafe permissions in the directory and its files", async () => {
    const { options, directory } = fake();
    const acquire = (dir = directory) => new Admission({ ...options, directory: dir }).acquire(AbortSignal.timeout(500), quiet);
    const link = path.join(fixtureDir(), "link");
    fs.symlinkSync(directory, link);
    await expect(acquire(link)).rejects.toThrow(/Unsafe.*directory/);
    await expect(acquire(path.join(link, "child"))).rejects.toThrow(/Unsafe.*directory/);
    fs.chmodSync(directory, 0o755);
    await expect(acquire()).rejects.toThrow(/Unsafe.*directory/);
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "admission.lock");
    const target = path.join(directory, "target");
    fs.writeFileSync(target, "untouched", { mode: 0o600 });
    fs.symlinkSync(target, file);
    await expect(acquire()).rejects.toMatchObject({ code: "ELOOP" });
    fs.unlinkSync(file);
    fs.linkSync(target, file);
    await expect(acquire()).rejects.toThrow(/Unsafe.*file/);
    fs.unlinkSync(file);
    fs.writeFileSync(file, "", { mode: 0o600 });
    fs.chmodSync(file, 0o644);
    await expect(acquire()).rejects.toThrow(/Unsafe.*file/);
    expect(fs.readFileSync(target, "utf8")).toBe("untouched");
  });
});

const unix = process.platform === "darwin" || process.platform === "linux";

function nativeOptions(directory: string, read: (now: number) => HostReading = healthy): AdmissionOptions {
  let now = 100_000;
  return {
    directory, now: () => now, headroom: { now: () => now, read: () => read(now) },
    wait: async (ms, signal) => { await delay(10, undefined, { signal }); now += ms; },
  };
}

function killGroup(pid: number) {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

function holdSlot(claim: Claim) {
  const shell = spawn("/bin/sh", ["-c", "sleep 10 & wait"], {
    detached: true, stdio: ["ignore", "ignore", "ignore", claim.fd],
  });
  claim.releaseAdmission();
  return shell;
}

async function stopShell(shell?: ChildProcess) {
  if (shell?.pid && shell.exitCode === null && shell.signalCode === null) {
    const exit = once(shell, "exit");
    killGroup(shell.pid);
    await exit;
  }
}

function nextReason(test: (reason: string) => boolean) {
  let notify!: (reason: string) => void;
  const reached = new Promise<string>((resolve) => { notify = resolve; });
  return { reached, reason: (reason: string) => { if (test(reason)) notify(reason); } };
}

describe.skipIf(!unix || process.env.PI_TEST_FULL !== "1")("native admission locks", () => {
  it("does not truncate locks or leak a slot when a granted payload cannot spawn", async () => {
    const directory = fixtureDir();
    const state = path.join(directory, "slot-1.lock");
    fs.writeFileSync(state, "ignored stale metadata", { mode: 0o600 });
    const admission = new Admission(nativeOptions(directory, missing));
    const claim = await admission.acquire(AbortSignal.timeout(2_000), quiet);
    try {
      expect(fs.fstatSync(claim.fd).ino).toBe(fs.statSync(state).ino);
      const child = spawn(path.join(directory, "absent"), [], { stdio: ["ignore", "ignore", "ignore", claim.fd] });
      expect((await once(child, "error"))[0]).toMatchObject({ code: "ENOENT" });
    } finally { release(claim); }
    release(await admission.acquire(AbortSignal.timeout(2_000), quiet));
    expect(fs.readFileSync(state, "utf8")).toBe("ignored stale metadata");
  });

  it.runIf(process.env.PI_TEST_FULL === "1")("lets two healthy shells overlap, but neither a third nor a cancelled sentinel starts", async () => {
    const admission = new Admission(nativeOptions(fixtureDir()));
    const signal = AbortSignal.timeout(3_000);
    const controller = new AbortController();
    const queuedSignal = AbortSignal.any([signal, controller.signal]);
    const first = await admission.acquire(signal, quiet);
    let second: Claim | undefined;
    let one: ChildProcess | undefined, two: ChildProcess | undefined;
    try {
      one = holdSlot(first);
      await once(one, "spawn");
      second = await admission.acquire(signal, quiet);
      two = holdSlot(second);
      await once(two, "spawn");
      expect(one.exitCode).toBeNull();
      expect(two.exitCode).toBeNull();
      const held = nextReason((reason) => reason.includes("both"));
      let sentinel = false;
      const pending = admission.acquire(queuedSignal, held.reason).then((claim) => { sentinel = true; release(claim); });
      const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await Promise.race([held.reached, pending]);
      controller.abort();
      await rejection;
      await stopShell(one);
      first.releaseSlot();
      release(await admission.acquire(signal, quiet));
      expect(sentinel).toBe(false);
    } finally {
      controller.abort();
      release(first);
      if (second) release(second);
      await Promise.all([stopShell(one), stopShell(two)]);
    }
  });

  it.runIf(process.env.PI_TEST_FULL === "1")("keeps a slot inherited by another process group after its owner crashes", async () => {
    const directory = fixtureDir();
    const url = new URL("../src/admission.ts", import.meta.url).href;
    const owner = spawn(process.execPath, ["--input-type=module", "-e", `
      import { spawn } from "node:child_process";
      import { Admission } from ${JSON.stringify(url)};
      const claim = await new Admission({ directory: process.argv[1], headroom: { read: () => ({}) } })
        .acquire(AbortSignal.timeout(2000), () => {});
      const shell = spawn("/bin/sh", ["-c", "sleep 10 & wait"], {
        detached: true, stdio: ["ignore", "ignore", "ignore", claim.fd],
      });
      shell.once("spawn", () => console.log(shell.pid));
      // Crash without closing either parent descriptor.
    `, directory], { cwd: fixtureDir(), stdio: ["ignore", "pipe", "inherit"] });
    const exit = once(owner, "exit");
    const lines = createInterface(owner.stdout);
    let group: number | undefined;
    try {
      const first = await lines[Symbol.asyncIterator]().next();
      if (first.done || !/^\d+$/.test(first.value)) throw new Error("owner did not report its shell PID");
      group = Number(first.value);
      owner.kill("SIGKILL");
      expect(await exit).toEqual([null, "SIGKILL"]);
      const signal = AbortSignal.timeout(3_000);
      const held = nextReason((reason) => reason === "waiting for host readings");
      const pending = new Admission(nativeOptions(directory, missing)).acquire(signal, held.reason);
      const firstDecision = await Promise.race([held.reached, pending]);
      if (typeof firstDecision !== "string") {
        release(firstDecision);
        throw new Error("slot became free while the crashed owner's shell still held its fd");
      }
      killGroup(group);
      group = undefined;
      release(await pending);
    } finally {
      lines.close();
      if (group !== undefined) killGroup(group);
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      await exit;
    }
  });
});
