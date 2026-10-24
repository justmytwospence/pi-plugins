import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tail } from "../src/log.ts";
import { Registry, type TaskEvent, checkoutRoot, groupAlive } from "../src/registry.ts";
import { until } from "./fake.ts";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-reg-"));
  process.env.PI_BG_DIR = dir;
});
afterAll(() => {
  delete process.env.PI_BG_DIR;
});

const base = { sessionId: "s1", origin: "agent" as const };

describe("registry", () => {
  it("runs a job to completion with its output in the log", async () => {
    const reg = new Registry();
    const events: TaskEvent["type"][] = [];
    reg.subscribe((e) => events.push(e.type));
    const t = reg.start({ ...base, command: "echo hello; echo err >&2", name: "hi", kind: "job", cwd: dir });
    await until(() => t.status !== "running");
    expect(t.status).toBe("done");
    expect(t.exitCode).toBe(0);
    expect(tail(t.logPath, 5)).toEqual(["hello", "err"]);
    expect(events).toEqual(["start", "end"]);
  });

  it("reports a failing job", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "exit 3", name: "fail", kind: "job", cwd: dir });
    await until(() => t.status !== "running");
    expect(t.status).toBe("failed");
    expect(t.exitCode).toBe(3);
  });

  it("sees a service's ready line, then kills its whole process group", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "sleep 30 & echo 'Listening on :3000'; wait", name: "srv", kind: "service", cwd: dir, ready: "listening on" });
    await until(() => t.ready, 4_000);
    expect(t.readyLine).toBe("Listening on :3000");
    expect(groupAlive(t.pid as number)).toBe(true);
    await reg.kill(t.id, "agent");
    expect(t.status).toBe("killed");
    await until(() => !groupAlive(t.pid as number), 2_000);
  });

  it("times a job out", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "sleep 30", name: "slow", kind: "job", cwd: dir, timeoutSec: 0.3 });
    await until(() => t.status !== "running", 5_000);
    expect(t.status).toBe("timeout");
  });

  it("finds tasks by id, prefix or name", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "true", name: "named", kind: "job", cwd: dir });
    expect(reg.find(t.id)).toBe(t);
    expect(reg.find("named")).toBe(t);
    expect(reg.find(t.id.slice(0, 4))).toBe(t);
    await until(() => t.status !== "running");
  });

  it("a later pi adopts kept services under its cwd and kills a crashed pi's orphans, checking each pid still runs our command", async () => {
    const a = new Registry();
    const kept = a.start({ ...base, command: "sleep 31", name: "kept", kind: "service", cwd: dir, keep: true });
    const orphan = a.start({ ...base, command: "sleep 32", name: "orphan", kind: "job", cwd: dir });
    const other = a.start({ ...base, command: "sleep 33", name: "other", kind: "job", cwd: dir });
    // Pretend the owner crashed: move its state file to a dead pid's name, and make one entry's
    // command not match what its pid runs (as if the pid had been reused).
    const own = path.join(dir, "state", `${process.pid}.json`);
    const entries = JSON.parse(fs.readFileSync(own, "utf8")).map((e: any) => (e.name === "other" ? { ...e, command: "something else entirely" } : e));
    fs.rmSync(own);
    fs.writeFileSync(path.join(dir, "state", "999999.json"), JSON.stringify(entries));
    const b = new Registry();
    const adopted = b.sweep(dir);
    expect(adopted.map((t) => t.name)).toEqual(["kept"]);
    await until(() => !groupAlive(orphan.pid as number), 3_000);
    expect(groupAlive(kept.pid as number)).toBe(true);
    // Not ours any more: left alone.
    expect(groupAlive(other.pid as number)).toBe(true);
    expect(fs.existsSync(path.join(dir, "state", "999999.json"))).toBe(false);
    await b.kill(kept.id, "user");
    expect(b.tasks.get(kept.id)?.status).toBe("killed");
    await a.kill(other.id, "user");
    await until(() => a.tasks.get(kept.id)?.status !== "running" && a.tasks.get(orphan.id)?.status !== "running");
  });

  it("a pi that quits leaves its kept services released, for any later pi under that cwd", async () => {
    const a = new Registry();
    const kept = a.start({ ...base, command: "sleep 34", name: "kept2", kind: "service", cwd: dir, keep: true });
    a.release();
    const own = path.join(dir, "state", `${process.pid}.json`);
    expect(JSON.parse(fs.readFileSync(own, "utf8"))).toMatchObject([{ name: "kept2", released: true }]);
    // The same pid looks alive, but released entries are adoptable anyway.
    fs.renameSync(own, path.join(dir, "state", `${process.ppid}.json`));
    const b = new Registry();
    expect(b.sweep(dir).map((t) => t.name)).toEqual(["kept2"]);
    await b.kill(kept.id, "user");
    await until(() => a.tasks.get(kept.id)?.status !== "running");
  });

  it("adopts kept services only within the same Git checkout, never across worktrees", async () => {
    const project = path.join(dir, "project");
    const worktree = path.join(project, ".worktrees", "branch");
    const notebooks = path.join(project, "notebooks");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), "gitdir: ../../.git/worktrees/branch\n");
    fs.mkdirSync(notebooks);
    expect(checkoutRoot(notebooks)).toBe(project);
    expect(checkoutRoot(worktree)).toBe(worktree);
    const a = new Registry();
    const main = a.start({ ...base, command: "sleep 35", name: "main-server", kind: "service", cwd: project, keep: true });
    const branch = a.start({ ...base, command: "sleep 36", name: "branch-server", kind: "service", cwd: worktree, keep: true });
    a.release();
    const own = path.join(dir, "state", `${process.pid}.json`);
    fs.renameSync(own, path.join(dir, "state", `${process.ppid}.json`));
    // A worktree session takes only the worktree's service; the main checkout's stays released.
    const b = new Registry();
    expect(b.sweep(worktree).map((t) => t.name)).toEqual(["branch-server"]);
    // A session lower in the main checkout takes the main checkout's, not the worktree's.
    const c = new Registry();
    expect(c.sweep(notebooks).map((t) => t.name)).toEqual(["main-server"]);
    await b.kill(branch.id, "user");
    await c.kill(main.id, "user");
    await until(() => a.tasks.get(main.id)?.status !== "running" && a.tasks.get(branch.id)?.status !== "running");
  });

  it("two sessions in one process see, kill and release only their own tasks; a gone session's kept services pass to the next", async () => {
    const reg = new Registry();
    reg.attach("main");
    reg.attach("planner");
    const mine = reg.start({ ...base, sessionId: "main", command: "sleep 30", name: "mine", kind: "job", cwd: dir });
    const theirs = reg.start({ ...base, sessionId: "planner", command: "sleep 30", name: "theirs", kind: "job", cwd: dir });
    const kept = reg.start({ ...base, sessionId: "planner", command: "sleep 30", name: "kept3", kind: "service", cwd: dir, keep: true });
    expect(reg.list("main").map((t) => t.name)).toEqual(["mine"]);
    expect(reg.running("planner").map((t) => t.name)).toEqual(["theirs", "kept3"]);
    expect(reg.find(theirs.id, "main")).toBeUndefined();
    expect(reg.find("theirs", "planner")?.id).toBe(theirs.id);
    expect(reg.list().length).toBe(3);
    // The planner quits: its job dies, the main session's job does not, and only its kept service is released.
    await reg.killAll("session", 1_000, "planner");
    await until(() => theirs.status !== "running");
    expect(mine.status).toBe("running");
    reg.release("planner");
    const own = path.join(dir, "state", `${process.pid}.json`);
    expect(JSON.parse(fs.readFileSync(own, "utf8")).map((e: { name: string; released?: boolean }) => [e.name, e.released ?? false])).toEqual([["mine", false], ["kept3", true]]);
    reg.detach("planner");
    // A /new in this process: the planner's ended job is forgotten and its kept service is the new session's, the user's, owing nothing.
    reg.attach("next");
    expect(reg.tasks.has(theirs.id)).toBe(false);
    expect(kept.sessionId).toBe("next");
    expect(kept.origin).toBe("user");
    expect(kept.delivered).toBe(true);
    expect(mine.sessionId).toBe("main");
    await reg.killAll("session");
    await reg.kill(kept.id, "user");
  });

  it("an exit 0 that races a stop still reads as done; processes the shell left behind die at session end", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "sleep 30 & exit 0", name: "leaves", kind: "job", cwd: dir });
    await until(() => t.status !== "running");
    expect(t.status).toBe("done");
    expect(t.strays).toBe(true);
    expect(groupAlive(t.pid as number)).toBe(true);
    await reg.killAll("session");
    await until(() => !groupAlive(t.pid as number), 3_000);
  });
});

describe("registry across a reload and over time", () => {
  it("a registry from an earlier load shares its state: old exit handlers reach new listeners", async () => {
    const old = new Registry();
    const t = old.start({ ...base, command: "sleep 0.5", name: "spans", kind: "job", cwd: dir });
    const next = new Registry();
    next.adopt(old);
    const seen: string[] = [];
    next.subscribe((e) => seen.push(`${e.type}:${e.task.name}`));
    expect(next.find("spans")).toBe(t);
    await until(() => t.status !== "running", 3_000);
    expect(seen).toEqual(["end:spans"]);
  });

  it("a running log past the cap is cut back to its tail", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "for i in $(seq 1 400); do echo line-$i; done; sleep 3", name: "chatty", kind: "job", cwd: dir });
    await until(() => (tail(t.logPath, 1)[0] ?? "") === "line-400", 3_000);
    reg.capLogs(1_000, 200);
    const lines = tail(t.logPath, 100);
    expect(lines[0]).toMatch(/^\[pi-bg\] log cut at /u);
    // The task keeps appending after the cut.
    expect(lines.at(-1)).toBe("line-400");
    expect(fs.statSync(t.logPath).size).toBeLessThan(300);
    await reg.kill(t.id, "agent");
  });
});
