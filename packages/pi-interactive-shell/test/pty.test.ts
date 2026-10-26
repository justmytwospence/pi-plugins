import { execFileSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { spawnPty, stopPty } from "../src/pty.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

test("signals the owned PTY group, including escalation after the leader is gone", async () => {
  vi.useFakeTimers();
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  const child = { pid: 12345, kill: vi.fn() } as any;
  const stopped = stopPty(child);
  expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
  await vi.advanceTimersByTimeAsync(400);
  await stopped;
  expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
  expect(child.kill).not.toHaveBeenCalled();
});

test("an already exited group is harmless", async () => {
  vi.useFakeTimers();
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  const child = { pid: 12345, kill: vi.fn() } as any;
  const stopped = stopPty(child);
  await vi.advanceTimersByTimeAsync(400);
  await stopped;
  expect(child.kill).not.toHaveBeenCalled();
});

test("native cleanup kills a TERM-resistant descendant without signaling Pi", async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  const child = await spawnPty('trap "" TERM; /bin/sh -c \'trap "" TERM; while :; do sleep 1; done\' & printf "CHILD:%s\\n" "$!"; wait', process.cwd(), 80, 8);
  let output = "";
  const ended = new Promise(resolve => child.onExit(resolve));
  child.onData(data => { output += data; });
  try {
    await vi.waitFor(() => expect(output).toMatch(/CHILD:\d+/));
    const descendant = Number(/CHILD:(\d+)/.exec(output)![1]);
    expect(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child.pid)], { encoding: "utf8" }).trim())).toBe(child.pid);
    await stopPty(child);
    await ended;
    await vi.waitFor(() => {
      let state = "";
      try { state = execFileSync("ps", ["-o", "stat=", "-p", String(descendant)], { encoding: "utf8" }).trim(); } catch { /* No process remains. */ }
      expect(state === "" || state.startsWith("Z")).toBe(true);
    });
  } finally { await stopPty(child); }
});

test("native PTY supports non-echoing input, terminal sizing and EOF", async () => {
  vi.stubEnv("SHELL", "/bin/bash");
  const child = await spawnPty("stty size; read -s -p READY value; printf '\\nANSWER:%s\\n' \"$value\"", process.cwd(), 40, 6);
  let output = "";
  const finished = new Promise<any>(resolve => child.onExit(resolve));
  child.onData(data => { output += data; });
  try {
    await vi.waitFor(() => expect(output).toContain("READY"));
    expect(output).toContain("6 40");
    child.write("dummy-native-input\r");
    const event = await finished;
    expect(event.exitCode).toBe(0);
    expect(output).toContain("ANSWER:dummy-native-input");
    expect(output.split("dummy-native-input")).toHaveLength(2); // Not echoed as input.
  } finally { await stopPty(child); }
});
