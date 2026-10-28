// The Vitest config of the evals not yet ported to targets (evals/shared/target.ts, run by
// scripts/eval.mjs), run from the package directory: `vitest run --config ../../evals/shared/vitest.config.ts`. A plain object rather than
// `defineConfig(...)`: nothing outside a package can resolve `vitest`, and defineConfig only types it.
// The evals are live against Jev through Pi's model registry and skip themselves without TypeSafe
// credentials.
export default { test: { include: ["eval/**/*.eval.ts"], testTimeout: 120_000 } };
