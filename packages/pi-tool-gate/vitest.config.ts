import { defineConfig } from "vitest/config";

// Tests run as an ordinary session even when started inside a subagent (see src/subagent-env.ts).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], env: { PI_SUBAGENT: "", PI_TOOL_GATE_APPROVAL: "", PI_TOOL_GATE_WORKFLOW: "" } },
});
