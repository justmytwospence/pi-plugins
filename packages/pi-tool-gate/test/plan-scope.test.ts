import { describe, expect, test } from "vitest";
import { DEFAULT_THRESHOLDS, planScopeQuestion, SCRIPT_NOTE } from "../src/judge.ts";
import { delegatedPlanText, inScratch, planEditBlockReason, planShellBlockReason, repoWriteCandidates } from "../src/plan-scope.ts";
import { inheritedModes, subagentEnv } from "../src/subagent-env.ts";

const scope = { root: "/r", planFile: "/p/plan.md", scratchDir: "/p/plan.spike" };

describe("plan scope", () => {
  test("the plan file and the scratch directory (not its siblings) are scratch", () => {
    expect(inScratch("/p/plan.md", scope)).toBe(true);
    expect(inScratch("/p/plan.spike/a/b.ts", scope)).toBe(true);
    expect(inScratch("/p/plan.spike", scope)).toBe(true);
    expect(inScratch("/p/plan.spikes/a", scope)).toBe(false);
    expect(inScratch("/p/other.md", scope)).toBe(false);
    expect(inScratch("/p/plan.md", {})).toBe(false);
  });

  test("repository writes split into git state and other files; everything else is ignored", () => {
    expect(repoWriteCandidates(["/r/src/a.ts", "/r/.git/HEAD", "/r/sub/.git", "/tmp/x", "/p/plan.spike/y", "/p/plan.md", "/rr/a"], scope)).toEqual({
      git: ["/r/.git/HEAD", "/r/sub/.git"],
      other: ["/r/src/a.ts"],
    });
    // A scratch directory inside the repository is still scratch.
    expect(repoWriteCandidates(["/r/.spike/a"], { root: "/r", scratchDir: "/r/.spike" })).toEqual({ git: [], other: [] });
  });

  test("block reasons say what may be written and what was judged", () => {
    expect(planEditBlockReason("/p/plan.md", "/p/plan.spike")).toBe("Plan mode is on: nothing in the repository may be edited until the user approves a plan. You may write the plan file, /p/plan.md, and scratch files under /p/plan.spike.");
    expect(planEditBlockReason()).toContain("only outside the repository");
    expect(planEditBlockReason(undefined, "/s")).toContain("You may write scratch files under /s.");
    expect(planShellBlockReason("bash", { files: ["/r/a", "/r/b"] }, "/s")).toBe("Plan mode is on: this bash call would write /r/a, /r/b in the repository, which stays unchanged until the user approves a plan. Write spikes and prototypes under /s. If this step must change the repository, put it in the plan; do not work around this block.");
    expect(planShellBlockReason("bash", {})).toMatch(/System 1 judged that this one might\. If this step must change/u);
    expect(planShellBlockReason("bash", { unavailable: true })).toContain("System 1 could not confirm that this one does not.");
    expect(delegatedPlanText("/s")).toContain("You may write scratch files (spikes, prototypes, notes) under /s.");
    expect(delegatedPlanText()).toContain("only outside the repository");
  });

  test("the question asks for exactly one answer, and a script adds its note", () => {
    const plain = planScopeQuestion();
    expect(Object.keys(plain)).toEqual(["leaves_repo_unchanged"]);
    expect(plain.leaves_repo_unchanged!.instructions).not.toContain(SCRIPT_NOTE);
    expect(planScopeQuestion({ script: true }).leaves_repo_unchanged!.instructions).toContain(SCRIPT_NOTE);
    expect(DEFAULT_THRESHOLDS.planScope).toBe(0.8);
  });
});

describe("subagent environment", () => {
  test("a planning parent passes plan and its scratch directory, a chat parent chat, a work parent neither", () => {
    expect(subagentEnv("auto", "plan", false, "/s")).toEqual({ PI_TOOL_GATE_APPROVAL: "auto", PI_TOOL_GATE_DENY_INSTEAD_OF_PROMPTING: "false", PI_TOOL_GATE_WORKFLOW: "plan", PI_TOOL_GATE_SCRATCH: "/s" });
    expect(subagentEnv("auto", "plan", false)).not.toHaveProperty("PI_TOOL_GATE_SCRATCH");
    expect(subagentEnv("auto", "chat", false, "/s")).toMatchObject({ PI_TOOL_GATE_WORKFLOW: "chat" });
    expect(subagentEnv("auto", "chat", false, "/s")).not.toHaveProperty("PI_TOOL_GATE_SCRATCH");
    expect(subagentEnv("auto", "work", false, "/s")).not.toHaveProperty("PI_TOOL_GATE_WORKFLOW");
  });

  test("a child reads plan and an absolute scratch directory only inside a subagent", () => {
    expect(inheritedModes({ PI_SUBAGENT: "1", PI_TOOL_GATE_WORKFLOW: "plan", PI_TOOL_GATE_SCRATCH: "/s" })).toEqual({ workflow: "plan", scratchDir: "/s" });
    expect(inheritedModes({ PI_SUBAGENT: "1", PI_TOOL_GATE_WORKFLOW: "plan", PI_TOOL_GATE_SCRATCH: "s" })).toEqual({ workflow: "plan" });
    expect(inheritedModes({ PI_SUBAGENT: "1", PI_TOOL_GATE_WORKFLOW: "chat", PI_TOOL_GATE_SCRATCH: "/s" })).toEqual({ workflow: "chat" });
    expect(inheritedModes({ PI_TOOL_GATE_WORKFLOW: "plan", PI_TOOL_GATE_SCRATCH: "/s" })).toEqual({});
  });
});
