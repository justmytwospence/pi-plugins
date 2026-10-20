import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
      // Tests must never reach TypeSafe; Jev tool selection falls back without a key.
      TYPESAFE_API_KEY: "",
      // Nor spawn terminal-browser: rendered plans are off unless a test brings its own.
      PI_PLAN_MODE_TERMINAL_BROWSER: "",
      // Nor open the developer's editor: "Edit the plan" uses pi's editor unless a test sets one.
      EDITOR: "",
      VISUAL: "",
    },
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/shared/vitest.global-setup.ts"],
    pool: "forks",
    runner: "./test/shared/vitest.runner.ts",
    setupFiles: ["./test/shared/vitest.setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 5_000,
  },
});
