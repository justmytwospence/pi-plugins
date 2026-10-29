// Every eval target, by explicit import (typed, no globbing), so this one file is the list that
// `npm run -s eval -- --list` shows. A target is the default export of `packages/<pkg>/eval/<id>.target.ts`
// (see evals/shared/target.ts). To add one, add its import and its entry below: one import per line and
// one entry per line, both alphabetical by id (the import is named after the id in camelCase), so parallel changes do not conflict. Ids are unique, kebab-case
// and never a package name (the runner selects by id, by package, or `all`).
import type { EvalTarget } from "./shared/target.ts";
import effort from "../packages/pi-auto-effort/eval/effort.target.ts";
import gate from "../packages/pi-tool-gate/eval/gate.target.ts";
import guard from "../packages/pi-sidebar/eval/guard.target.ts";
import lean from "../packages/pi-cache-guard/eval/lean.target.ts";
import midrun from "../packages/pi-auto-effort/eval/midrun.target.ts";
import pick from "../packages/pi-subagents/eval/pick.target.ts";
import profiles from "../packages/pi-subagents/eval/profiles.target.ts";
import rank from "../packages/pi-copy/eval/rank.target.ts";
import replay from "../packages/pi-auto-effort/eval/replay.target.ts";
import replayFile from "../packages/pi-tool-gate/eval/replay-file.target.ts";
import sessions from "../packages/pi-tool-gate/eval/sessions.target.ts";
import vet from "../packages/pi-next-prompt/eval/vet.target.ts";
// Add the other targets' imports here, alphabetical by id.

export const targets: readonly EvalTarget[] = [
  effort,
  gate,
  guard,
  lean,
  midrun,
  pick,
  profiles,
  rank,
  replay,
  replayFile,
  sessions,
  vet,
  // Add the other targets here, in the same order as the imports.
];

export default targets;
