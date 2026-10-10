import { expect, test } from "vitest";
import piCopy from "../src/index.ts";
import { harness, userEntry } from "./harness.ts";

function setup(mode: string, branch: unknown[]) {
  const h = harness();
  piCopy(h.pi);
  const ctx = h.ctx({ mode, sessionManager: { getBranch: () => branch } });
  ctx.ui.custom = async () => {
    h.events.push({ channel: "ui.custom", data: undefined });
    return undefined;
  };
  return { h, ctx };
}

test("the open /yank picker holds herdr:blocked", async () => {
  const { h, ctx } = setup("tui", [userEntry("Run npm test in packages/app")]);
  await h.commands.get("yank").handler("", ctx);
  expect(h.events).toEqual([
    { channel: "herdr:blocked", data: { active: true, label: "Yank picker" } },
    { channel: "ui.custom", data: undefined },
    { channel: "herdr:blocked", data: { active: false } },
  ]);
});

test("no picker, no hold: outside the terminal UI or with nothing to copy", async () => {
  const rpc = setup("rpc", [userEntry("Run npm test")]);
  await rpc.h.commands.get("yank").handler("", rpc.ctx);
  expect(rpc.h.events).toEqual([]);
  expect(rpc.ctx.ui.notes).toEqual([{ message: "/yank needs the interactive terminal UI.", type: "warning" }]);

  const empty = setup("tui", []);
  await empty.h.commands.get("yank").handler("", empty.ctx);
  expect(empty.h.events).toEqual([]);
  expect(empty.ctx.ui.notes[0]?.message).toBe("Nothing to copy yet.");
});
