import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		setupFiles: ["./test/setup.ts"],
		pool: "forks",
		maxWorkers: 4,
		hookTimeout: 30_000,
		testTimeout: 15_000,
		clearMocks: true,
		restoreMocks: true,
		unstubGlobals: true,
		unstubEnvs: true,
	},
});
