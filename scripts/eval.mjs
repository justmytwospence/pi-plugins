#!/usr/bin/env node
// `npm run -s eval -- [<id|package|all>...] [--package <pkg>] [--dry | --list | --last] [--json]`: the one
// command for every eval target (evals/targets.ts). All of the behavior is in evals/shared/runner.ts; this
// file only loads the TypeScript through jiti, so it runs under plain `node` as well as `jiti`.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { runEval } = await jiti.import("../evals/shared/runner.ts");
const { targets } = await jiti.import("../evals/targets.ts");
process.exitCode = await runEval(process.argv.slice(2), { targets });
