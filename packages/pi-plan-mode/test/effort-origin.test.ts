import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, test } from "vitest";
import { effortOrigin, withEffortOrigin } from "../src/effort-origin.ts";

describe("effort write provenance", () => {
  test("unowned writes remain unowned and synchronous scope restores", () => {
    const setter = () => effortOrigin();
    expect(setter()).toBeUndefined();
    expect(withEffortOrigin("flow", setter)).toBe("flow");
    expect(setter()).toBeUndefined();
    expect(() =>
      withEffortOrigin("plan", () => {
        throw new Error("setter failed");
      }),
    ).toThrow("setter failed");
    expect(setter()).toBeUndefined();
  });

  test("native asynchronous model/default dispatch inherits its owner without poisoning manual dispatch", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owned = withEffortOrigin("flow", async () => {
      await pending;
      const nativeDefaultEvent = () => effortOrigin();
      return nativeDefaultEvent();
    });
    expect(effortOrigin()).toBeUndefined();
    const manual = Promise.resolve().then(() => effortOrigin());
    release();
    expect(await owned).toBe("flow");
    expect(await manual).toBeUndefined();
    expect(effortOrigin()).toBeUndefined();
  });

  test("the versioned process slot is shared across package-local copies", async () => {
    const shared = (globalThis as Record<symbol, unknown>)[
      Symbol.for("pi-plugins.effort-origin.v1")
    ] as AsyncLocalStorage<string>;
    expect(shared).toBeInstanceOf(AsyncLocalStorage);
    await withEffortOrigin("plan-approved", async () => {
      await Promise.resolve();
      expect(shared.getStore()).toBe("plan-approved");
      expect(withEffortOrigin("flow", effortOrigin)).toBe("flow");
      expect(effortOrigin()).toBe("plan-approved");
    });
    expect(shared.getStore()).toBeUndefined();
  });
});
