import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { mermaidArt, normalizeMermaid, PlanMarkdown } from "../src/mermaid-art.js";

initTheme("dark");

const PLAN = [
  "# Plan",
  "",
  "```mermaid",
  "flowchart LR",
  "  Client --> Gateway --> API",
  "```",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

test("a plan's Mermaid blocks become terminal diagrams; other code stays code", () => {
  const art = mermaidArt(PLAN, 120);
  assert.doesNotMatch(art, /```mermaid/u, "the diagram replaces its source");
  assert.match(art, /Client/u);
  assert.match(art, /[┌─│└▶]/u, "drawn with box characters");
  assert.match(art, /```ts\nconst x = 1;\n```/u);
  assert.equal(mermaidArt(PLAN, 5), PLAN, "a diagram wider than the view keeps its source");
  assert.equal(mermaidArt("```mermaid\nnot a diagram at all ((\n```", 120).includes("```mermaid"), true);
  assert.equal(mermaidArt("no diagrams", 80), "no diagrams");
});

test("the plan view draws the diagram for the width it renders at", () => {
  const view = new PlanMarkdown(PLAN, getMarkdownTheme());
  const lines = view.render(100).map((line) => stripVTControlCharacters(line));
  const row = lines.find((line) => line.includes("Client"));
  assert.ok(row, lines.join("\n"));
  assert.match(row, /Gateway/u, "boxes side by side, left to right");
  assert.ok(lines.every((line) => visibleWidth(line) <= 100));
  assert.ok(
    !view.render(5).some((line) => /[┌╭▶]/u.test(stripVTControlCharacters(line))),
    "too narrow even top-down: the source, not a broken diagram",
  );
});

test("labels with semicolons are quoted, and a wide left-to-right chart is drawn top-down", () => {
  assert.equal(
    normalizeMermaid("  D[Resolve tier; refill bucket] --> E{One; two}"),
    '  D["Resolve tier; refill bucket"] --> E{"One; two"}',
  );
  assert.equal(normalizeMermaid('A["already; quoted"] --> B[plain]'), 'A["already; quoted"] --> B[plain]');
  const wide = [
    "```mermaid",
    "flowchart LR",
    "  A[GET/POST /v1/orders] --> B{Valid X-API-Key?}",
    "  B -->|No| C[401]",
    "  B -->|Yes| D[Resolve tier; refill key bucket]",
    "  D --> E{At least 1 token?}",
    "  E -->|Yes: consume 1| F[Existing orders handler]",
    "  E -->|No| G[429 + Retry-After]",
    "```",
  ].join("\n");
  const art = mermaidArt(wide, 80);
  assert.doesNotMatch(art, /```mermaid/u, "drawn, not left as source");
  assert.match(art, /Resolve tier; refill key/u, "the whole label, semicolon and all");
  const rows = art.split("\n").filter((line) => line.includes("`"));
  assert.ok(
    rows.findIndex((line) => line.includes("GET/POST")) < rows.findIndex((line) => line.includes("Valid X-API-Key")),
    "top-down",
  );
});
