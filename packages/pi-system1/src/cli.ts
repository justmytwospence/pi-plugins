import type { Provider } from "@earendil-works/pi-ai";
import { registerDecisionsProvider } from "./provider.js";
import {
  askSystem1, formatSystem1Notice, provenanceOf, readSystem1Setting, resolveSystem1Route,
  type ClassifierQuestion,
} from "./system1.js";

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
  | { ok: true; normalized: ReturnType<typeof normalize>; selectionKey: string }
  | { ok: false; result: CliResult } {
  let normalized: ReturnType<typeof normalize>;
  try { normalized = normalize(request); } catch (error) {
    return { ok: false, result: failure(2, error instanceof Error ? error.message : "invalid request") };
  }
  const setting = readSystem1Setting();
  if (!setting.ok) return { ok: false, result: failure(1, setting.reason) };
  const jevOnly = setting.waterfall.length === 1 && setting.waterfall[0] === "jev";
  if (normalized.experimental.length) {
    return { ok: false, result: failure(2,
      `${[...new Set(normalized.experimental)].join(", ")} requests require the legacy jev-ask implementation under an explicit Jev-only chain (waterfall: ["jev"])`) };
  }
  if (normalized.modelOverride && !jevOnly) {
    return { ok: false, result: failure(2, "request-level model override requires a singleton Jev-only chain (waterfall: [\"jev\"])") };
  }
  const route = resolveSystem1Route({ provider: "typesafe", model: normalized.model }, setting);
  if (!route.ok) return { ok: false, result: failure(1, route.reason) };
  return { ok: true, normalized, selectionKey: route.key };
}

/** Input/selection preflight only; safe before constructing any model or credential runtime. */
export function validateCliRequest(request: unknown): CliResult | undefined {
  const prepared = prepareRequest(request);
  return prepared.ok ? undefined : prepared.result;
}

/** No chat session or project extensions: only the configured native waterfall and its registry. */
export async function runCli(request: unknown, registry: unknown): Promise<CliResult> {
  const prepared = prepareRequest(request);
  if (!prepared.ok) return prepared.result;
  const { normalized, selectionKey } = prepared;
  const config = { enabled: true, provider: "typesafe", model: normalized.model, timeoutMs: 5_000 };
  const reg = registry as { registerProvider?(provider: Provider): void } | undefined;
  try {
    if (typeof reg?.registerProvider === "function") {
      await registerDecisionsProvider(reg as { registerProvider(provider: Provider): void });
    }
  } catch {
    // Optional native registration must not stop a viable Jev rung. The executor handles
    // missing capability for every configured target and sanitizes whole-chain failures.
  }
  // Fence the entire resolved order, including manual resets, after any bootstrap outcome.
  // Never reinterpret a request against a replacement policy, even without a model override.
  if (resolveSystem1Route(config).key !== selectionKey) {
    return failure(1, "System 1 selection changed during provider registration; run the request again");
  }
  const notices: string[] = [];
  const result = await askSystem1(registry, config, normalized.state, normalized.questions, undefined, {
    onNotice: (notice) => { notices.push(`${formatSystem1Notice(notice)}\n`); },
  });
  const stderr = notices.join("");
  if (!result.ok) {
    const failed = failure(result.code === "invalid_input" ? 2 : 1, result.reason);
    return { ...failed, stderr: stderr + failed.stderr };
  }
  return {
    exitCode: 0, stderr,
    stdout: `${JSON.stringify({ ...provenanceOf(result), answers: result.answers,
      usage: result.usage ?? null }, null, 2)}\n`,
  };
}
