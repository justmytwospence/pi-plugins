import {
  judgeTaskEffort,
  type recommendTaskEffort,
  type TaskEffortInput,
  type TaskEffortJudgment,
} from "./task-effort.js";

export type EffortSource = "manual" | "configured" | "system1" | "fallback";
export type ImplementationEffortPick = ReturnType<typeof recommendTaskEffort>;
export type PickImplementationEffortInput = Omit<TaskEffortInput, "phase" | "task">;

export interface ImplementationEffortRequest {
  key: string;
  isCurrent(): boolean;
  pick(target: { provider: string; modelId: string }, signal?: AbortSignal): Promise<ImplementationEffortPick>;
  dispose(): void;
}

/** Exec judges settled implementation only; target quota is applied separately by the approval owner. */
export function pickImplementationEffort(input: PickImplementationEffortInput): Promise<TaskEffortJudgment> {
  if (!input.plan?.trim()) return Promise.resolve({ kind: "fallback", reason: "no plan to judge" });
  return judgeTaskEffort({ ...input, phase: "exec", task: "" });
}
