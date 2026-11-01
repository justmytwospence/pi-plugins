import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { ToolNode } from "../src/tool-tree.js";
import { type ToolPreselection, ToolTreeView } from "../src/tool-tree-view.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function pendingPick() {
  let resolve!: (result: Awaited<ToolPreselection["pending"]>) => void;
  const pending = new Promise<Awaited<ToolPreselection["pending"]>>((done) => {
    resolve = done;
  });
  return { pending, resolve };
}

function view(roots: ToolNode[], preselection: ToolPreselection) {
  let renders = 0;
  const screen = new ToolTreeView(theme, {
    title: "Planners",
    notes: [],
    roots,
    startLabel: "Start planning with 1 planner",
    preselection,
    rows: () => 25,
    requestRender: () => renders++,
    onDone: () => undefined,
  });
  return { screen, renders: () => renders };
}

for (const label of ["Jev", "Decisions"]) {
  test(`System 1 shows actual ${label} backend while pending and completed at narrow and wide widths`, async () => {
    const pick = pendingPick();
    const roots = [{ id: "research", label: "Research", description: "Research", selected: false }];
    const { screen, renders } = view(roots, { label, pending: pick.pending });
    for (const width of [46, 120, 180]) {
      const lines = screen.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(lines.join("\n"), new RegExp(`System 1.*${label}: picking tools`, "u"));
    }
    pick.resolve({
      message: `${label} picked 1 tools for this task.`,
      apply: (keep) => {
        if (!keep) roots[0].selected = true;
      },
    });
    await pick.pending;
    assert.equal(roots[0].selected, true);
    assert.equal(renders(), 1);
    assert.match(screen.render(120).join("\n"), new RegExp(`System 1.*${label} picked`, "u"));
  });
}

test("a stale backend pick is neither applied nor presented as a completed selection", async () => {
  const pick = pendingPick();
  let applied = false;
  const { screen } = view([], { label: "Jev", pending: pick.pending });
  pick.resolve({
    message: "Jev picked 2 tools for this task.",
    isCurrent: () => false,
    apply: () => {
      applied = true;
    },
  });
  await pick.pending;
  assert.equal(applied, false);
  assert.match(screen.render(120).join("\n"), /System 1 changed/u);
  assert.doesNotMatch(screen.render(120).join("\n"), /Jev picked/u);
});

test("a manual edit wins over a late automatic selection", async () => {
  const pick = pendingPick();
  const roots = [{ id: "research", label: "Research", description: "Research", selected: false }];
  const { screen } = view(roots, { label: "Decisions", pending: pick.pending });
  screen.handleInput(" ");
  assert.equal(roots[0].selected, true);
  let kept = false;
  pick.resolve({
    message: "Decisions picked 0 tools for this task.",
    isCurrent: () => true,
    apply: (keep) => {
      kept = keep;
      if (!keep) roots[0].selected = false;
    },
  });
  await pick.pending;
  assert.equal(kept, true);
  assert.equal(roots[0].selected, true);
  assert.match(screen.render(120).join("\n"), /Your own changes were kept/u);
});

test("closing the tree before completion prevents any late application or redraw", async () => {
  const pick = pendingPick();
  const { screen, renders } = view([], { label: "Jev", pending: pick.pending });
  screen.dispose();
  pick.resolve({ message: "Jev picked tools.", apply: () => assert.fail("closed picker applied a result") });
  await pick.pending;
  assert.equal(renders(), 0);
});
