import { defineConfig } from "vitest/config";

// Tests represent the parent session even when the test runner is launched by a nested agent.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], env: { PI_SUBAGENT: "", PI_SUBAGENT_DEPTH: "0" } } });
