import { defineConfig } from "vitest/config";

// Fake-timer tests that advance an hour of ticks are CPU-bound and slow under parallel checks.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 15_000 } });
