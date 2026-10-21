import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyUpdate, emptyProfile, mastery, profileSummary, ProfileStore, progressLines, relevantConcepts, standing } from "../src/quiz/profile.ts";
import type { QuizUpdate } from "../src/quiz/protocol.ts";

const DAY = 86_400_000;
const T0 = 1_000 * DAY;
const grade = (result: QuizUpdate["result"], difficulty: 1 | 2 | 3 = 2, concept = "retry", paths: string[] = ["src/retry.ts"]): QuizUpdate => ({ concept, title: "Retries", result, difficulty, paths });

describe("knowledge profile", () => {
  it("starts new, and proves a concept only with enough correct answers", () => {
    let p = emptyProfile("/repo");
    p = applyUpdate(p, grade("correct", 3), T0);
    expect(standing(p.concepts.retry!, T0)).toBe("learning");
    p = applyUpdate(p, grade("correct", 3), T0);
    expect(mastery(p.concepts.retry!, T0)).toBeGreaterThanOrEqual(0.8);
    expect(standing(p.concepts.retry!, T0)).toBe("proven");
  });

  it("needs harder questions than recall to prove", () => {
    let p = emptyProfile("/repo");
    p = applyUpdate(p, grade("correct", 1), T0);
    p = applyUpdate(p, grade("correct", 1), T0);
    expect(standing(p.concepts.retry!, T0)).toBe("learning");
  });

  it("marks wrong answers shaky and partial ones in between", () => {
    let p = applyUpdate(emptyProfile("/repo"), grade("wrong"), T0);
    expect(standing(p.concepts.retry!, T0)).toBe("shaky");
    p = applyUpdate(emptyProfile("/repo"), grade("partial"), T0);
    expect(mastery(p.concepts.retry!, T0)).toBeCloseTo(0.5);
  });

  it("lets old evidence fade, so a proven concept comes due", () => {
    let p = emptyProfile("/repo");
    p = applyUpdate(p, grade("correct", 3), T0);
    p = applyUpdate(p, grade("correct", 3), T0);
    const later = T0 + 30 * DAY;
    expect(mastery(p.concepts.retry!, later)).toBeLessThan(mastery(p.concepts.retry!, T0));
    expect(standing(p.concepts.retry!, later)).toBe("due");
  });

  it("counts a skipped question as asked, without evidence", () => {
    const p = applyUpdate(emptyProfile("/repo"), grade("skipped"), T0);
    expect(p.concepts.retry).toMatchObject({ attempts: 1, success: 0, failure: 0 });
    expect(standing(p.concepts.retry!, T0)).toBe("new");
  });

  it("lists concepts on changed files first, then the weakest", () => {
    let p = emptyProfile("/repo");
    p = applyUpdate(p, grade("wrong", 2, "weak", ["src/a.ts"]), T0);
    p = applyUpdate(p, grade("correct", 2, "near", ["src/b.ts"]), T0);
    p = applyUpdate(p, grade("correct", 2, "far", ["src/c.ts"]), T0);
    expect(relevantConcepts(p, ["src/b.ts"], T0).map((c) => c.id)).toEqual(["near", "weak", "far"]);
    expect(profileSummary(p, ["src/b.ts"], T0)).toMatch(/^- near: Retries \(71%, learning, 1\/1 correct/);
    expect(profileSummary(emptyProfile("/repo"), [], T0)).toMatch(/first quiz/);
  });

  it("shows progress with bars, weakest first", () => {
    let p = applyUpdate(emptyProfile("/repo"), grade("correct", 3, "strong"), T0);
    p = applyUpdate(p, grade("correct", 3, "strong"), T0);
    p = applyUpdate(p, grade("wrong", 2, "weak"), T0);
    const lines = progressLines(p, T0);
    expect(lines[0]).toBe("2 concepts: 1 proven, 0 learning, 1 shaky, 0 due for review");
    expect(lines[1]).toContain("shaky");
    expect(lines[2]).toMatch(/█+.* proven/);
  });
});

describe("ProfileStore", () => {
  it("saves per repository and reads it back", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "quiz-"));
    const store = new ProfileStore(dir, "/work/my repo");
    expect(path.basename(store.file)).toMatch(/^my-repo-[0-9a-f]{10}\.json$/);
    store.apply([grade("correct")], T0);
    const again = new ProfileStore(dir, "/work/my repo").load();
    expect(again.concepts.retry).toMatchObject({ attempts: 1, correct: 1 });
    expect(new ProfileStore(dir, "/work/other").file).not.toBe(store.file);
  });

  it("sets an unreadable file aside instead of overwriting it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "quiz-"));
    const store = new ProfileStore(dir, "/repo");
    writeFileSync(store.file, "{ not json");
    expect(store.load().concepts).toEqual({});
    expect(readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(true);
    store.apply([grade("wrong")], T0);
    expect(JSON.parse(readFileSync(store.file, "utf8")).concepts.retry.failure).toBe(1.5);
  });
});
