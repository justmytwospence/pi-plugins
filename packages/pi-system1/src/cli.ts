import type { Provider } from "@earendil-works/pi-ai";
import { registerDecisionsProvider } from "./provider.js";
import { askSystem1, readSystem1Setting, type ClassifierQuestion } from "./system1.js";

type CliResult = { exitCode: number; stdout: string; stderr: string };
const failure = (exitCode: number, reason: string): CliResult => ({ exitCode, stdout: "", stderr: `system1: ${reason}\n` });
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Normalize the ordinary legacy shell contract before looking up models or credentials. */
function normalize(request: unknown): {
  state: Record<string, unknown>; questions: Record<string, ClassifierQuestion>; model: string;
  experimental: string[]; modelOverride: boolean;
} {
  if (!record(request)) throw new Error("the request must be a JSON object with state and questions");
  if (Object.keys(request).some((key) => !["state", "questions", "model", "assets", "long_context"].includes(key))) {
    throw new Error("unknown request fields; expected state, questions, model, assets or long_context");
  }
  if (!Object.hasOwn(request, "state") || request.state === undefined) throw new Error("state is required");
  try { JSON.stringify(request.state); } catch { throw new Error("state must be JSON serializable"); }
  if (!record(request.questions) || !Object.keys(request.questions).length) {
    throw new Error("questions must be a nonempty object mapping IDs to typed questions");
  }
  if (Object.hasOwn(request, "model") && (typeof request.model !== "string" || !request.model.trim())) {
    throw new Error("model must be a nonempty string");
  }
  const experimental = ["assets", "long_context"].filter((key) => Object.hasOwn(request, key));
  const entries: [string, ClassifierQuestion][] = [];
  for (const [id, question] of Object.entries(request.questions)) {
    if (!record(question) || typeof question.instructions !== "string") {
      throw new Error("each question needs a type and string instructions");
    }
    if (question.type === "box") { experimental.push("box"); continue; }
    const instructions = question.instructions;
    const criteria = question.criteria;
    if (question.type === "bool" || question.type === "noul") {
      if (criteria !== undefined && (!record(criteria) ||
          Object.values(criteria).some((value) => typeof value !== "string"))) {
        throw new Error("bool/noul criteria must map true and false to descriptions");
      }
      const values = criteria as Record<string, string> | undefined;
      entries.push([id, { type: "bool", instructions, criteria: { true: values?.true ?? "True", false: values?.false ?? "False" } }]);
    } else if (question.type === "choice") {
      if (!record(criteria) || !Object.keys(criteria).length || Object.values(criteria).some((value) => typeof value !== "string")) {
        throw new Error("choice criteria must be a nonempty object mapping labels to descriptions");
      }
      entries.push([id, { type: "choice", instructions, criteria: { ...criteria } as Record<string, string> }]);
    } else if (question.type === "score") {
      if (!Array.isArray(criteria) || !criteria.length || criteria.some((value) => typeof value !== "string")) {
        throw new Error("score criteria must be a nonempty array of ordered descriptions");
      }
      entries.push([id, { type: "score", instructions, criteria: [...criteria] as string[] }]);
    } else {
      throw new Error("question type must be bool, noul, choice or score");
    }
  }
  return {
    state: record(request.state) ? request.state : { input: request.state },
    questions: Object.fromEntries(entries), model: typeof request.model === "string" ? request.model : "jev-latest",
    experimental, modelOverride: Object.hasOwn(request, "model"),
  };
}

function prepareRequest(request: unknown):
  | { ok: true; normalized: ReturnType<typeof normalize>; backend: "jev" | "openai-decisions" }
  | { ok: false; result: CliResult } {
  let normalized: ReturnType<typeof normalize>;
  try { normalized = normalize(request); } catch (error) {
    return { ok: false, result: failure(2, error instanceof Error ? error.message : "invalid request") };
  }
  const setting = readSystem1Setting();
  if (!setting.ok) return { ok: false, result: failure(1, setting.reason) };
  if (setting.backend === "openai-decisions") {
    const unsupported = [...normalized.experimental, ...(normalized.modelOverride ? ["request-level model override"] : [])];
    if (unsupported.length) return { ok: false, result: failure(2, `OpenAI Decisions does not support ${[...new Set(unsupported)].join(", ")}`) };
  } else if (normalized.experimental.length) {
    return { ok: false, result: failure(2, "experimental box/assets/long_context requests require the legacy jev-ask implementation in Jev mode") };
  }
  return { ok: true, normalized, backend: setting.backend };
}

/** Input/selection preflight only; safe before constructing any model or credential runtime. */
export function validateCliRequest(request: unknown): CliResult | undefined {
  const prepared = prepareRequest(request);
  return prepared.ok ? undefined : prepared.result;
}

/** No chat session or project extensions: only the selected native classifier and its registry. */
export async function runCli(request: unknown, registry: unknown): Promise<CliResult> {
  const prepared = prepareRequest(request);
  if (!prepared.ok) return prepared.result;
  const { normalized, backend } = prepared;
  const reg = registry as { registerProvider?(provider: Provider): void } | undefined;
  try {
    const registered = typeof reg?.registerProvider === "function" && await registerDecisionsProvider(reg as { registerProvider(provider: Provider): void });
    if (!registered && backend === "openai-decisions") {
      return failure(1, "OpenAI Decisions is unavailable; update Pi and enable pi-system1, then configure /login system1-openai");
    }
  } catch {
    return failure(1, "System 1 provider registration failed");
  }
  // Registration is asynchronous. A switch during bootstrap must not turn a legacy model
  // override into an implicitly accepted native request.
  const current = readSystem1Setting();
  if (!current.ok) return failure(1, current.reason);
  if (current.backend === "openai-decisions" && normalized.modelOverride) {
    return failure(2, "OpenAI Decisions does not support request-level model override");
  }
  const result = await askSystem1(registry, {
    enabled: true, provider: "typesafe", model: normalized.model, timeoutMs: 5_000,
  }, normalized.state, normalized.questions);
  if (!result.ok) return failure(1, result.reason);
  return {
    exitCode: 0, stderr: "",
    stdout: `${JSON.stringify({ backend: result.backend, provider: result.provider, model: result.model,
      answers: result.answers, usage: result.usage ?? null }, null, 2)}\n`,
  };
}
