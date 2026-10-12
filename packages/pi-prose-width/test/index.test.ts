import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Markdown, type MarkdownTheme, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import extension, { configuredMeasure, install as acquire, parseMeasure, type Installation } from "../src/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const leases: Installation[] = [];
const install = (measure: number) => {
  const lease = acquire(measure);
  leases.push(lease);
  return lease;
};
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
});

const id = (s: string) => s;
const theme: MarkdownTheme = {
  heading: id, link: id, linkUrl: id, code: id, codeBlock: id, codeBlockBorder: id, quote: id,
  quoteBorder: id, hr: id, listBullet: id, bold: id, italic: id, strikethrough: id, underline: id,
};

const LONG = "word ".repeat(40).trim();
const LONG_CODE = `echo ${"x".repeat(110)}`;

function lines(md: string, width = 120): string[] {
  return new Markdown(md, 0, 0, theme).render(width).map((l) => stripTerminalSequences(l).trimEnd());
}
const widest = (ls: string[]) => Math.max(...ls.map((l) => visibleWidth(stripTerminalSequences(l).trimEnd())));

beforeEach(() => {
  install(72);
});

describe("rendering", () => {
  test("paragraphs and headings wrap at the measure", () => {
    expect(widest(lines(LONG))).toBeLessThanOrEqual(72);
    expect(widest(lines(`## ${LONG}`))).toBeLessThanOrEqual(72);
    expect(widest(lines(LONG, 50))).toBeLessThanOrEqual(50);
  });

  test("lists and quotes wrap at the measure", () => {
    expect(widest(lines(`- ${LONG}\n- short`))).toBeLessThanOrEqual(72);
    expect(widest(lines(`> ${LONG}`))).toBeLessThanOrEqual(72);
  });

  test("code blocks and tables keep the full width", () => {
    const code = lines("```sh\n" + LONG_CODE + "\n```");
    expect(code).toContain(`  ${LONG_CODE}`);
    const table = lines(`| a | b |\n|---|---|\n| ${LONG} | x |`);
    expect(widest(table)).toBeGreaterThan(72);
  });

  test("a list holding a long code line keeps the full width", () => {
    const md = `- ${LONG}\n\n  \`\`\`sh\n  ${LONG_CODE}\n  \`\`\``;
    expect(widest(lines(md))).toBeGreaterThan(72);
  });

  test("off and a new measure redraw cached components", () => {
    const md = new Markdown(LONG, 0, 0, theme);
    expect(widest(md.render(120))).toBeLessThanOrEqual(72);
    install(0);
    expect(widest(md.render(120))).toBeGreaterThan(72);
    install(40);
    expect(widest(md.render(120))).toBeLessThanOrEqual(40);
  });
});

describe("ownership and lifecycle", () => {
  test("last release restores prototypes and invalidates already-rendered Markdown", () => {
    for (const lease of leases.splice(0)) lease.dispose();
    const proto = Markdown.prototype as unknown as { render: Markdown["render"]; renderToken: unknown };
    const originalRender = proto.render;
    const originalToken = proto.renderToken;
    const lease = install(40);
    const md = new Markdown(LONG, 0, 0, theme);
    expect(widest(md.render(120))).toBeLessThanOrEqual(40);
    lease.dispose();
    lease.dispose();
    expect(proto.render).toBe(originalRender);
    expect(proto.renderToken).toBe(originalToken);
    expect(widest(md.render(120))).toBeGreaterThan(40);
    install(50);
    expect(widest(md.render(120))).toBeLessThanOrEqual(50);
  });

  test("an older owner cannot remove a newer runtime's patch", () => {
    for (const lease of leases.splice(0)) lease.dispose();
    const old = install(40);
    const current = install(60);
    old.dispose();
    old.setMeasure(20);
    expect(current.measure).toBe(60);
    expect(widest(lines(LONG))).toBeGreaterThan(40);
    expect(widest(lines(LONG))).toBeLessThanOrEqual(60);
    current.dispose();
    expect(widest(lines(LONG))).toBeGreaterThan(60);
  });

  test("does not clobber later wrappers and disables retained delegates", () => {
    for (const lease of leases.splice(0)) lease.dispose();
    const proto = Markdown.prototype as unknown as { render: Markdown["render"]; renderToken: (...args: unknown[]) => string[] };
    const originalRender = proto.render;
    const originalToken = proto.renderToken;
    const lease = install(40);
    const delegatedRender = proto.render;
    const delegatedToken = proto.renderToken;
    const render = function (this: Markdown, width: number) { return delegatedRender.call(this, width); };
    const token = function (this: Markdown, ...args: unknown[]) { return delegatedToken.apply(this, args); };
    proto.render = render;
    proto.renderToken = token;
    try {
      const md = new Markdown(LONG, 0, 0, theme);
      expect(widest(md.render(120))).toBeLessThanOrEqual(40);
      lease.dispose();
      expect(proto.render).toBe(render);
      expect(proto.renderToken).toBe(token);
      expect(widest(md.render(120))).toBeGreaterThan(40);
    } finally {
      proto.render = originalRender;
      proto.renderToken = originalToken;
    }
  });

  test("factory/headless load is inert and session shutdown releases the TUI lease", async () => {
    for (const lease of leases.splice(0)) lease.dispose();
    const render = Markdown.prototype.render;
    const handlers = new Map<string, (...args: any[]) => any>();
    let command: any;
    extension({
      on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
      registerCommand: (_name: string, definition: any) => { command = definition; },
    } as unknown as ExtensionAPI);
    expect(Markdown.prototype.render).toBe(render);
    handlers.get("session_start")!({}, { mode: "rpc" });
    expect(Markdown.prototype.render).toBe(render);
    handlers.get("session_start")!({}, { mode: "tui" });
    expect(Markdown.prototype.render).not.toBe(render);
    const notify = vi.fn();
    await command.handler("45", { ui: { notify } });
    expect(widest(lines(LONG))).toBeLessThanOrEqual(45);
    handlers.get("session_shutdown")!();
    expect(Markdown.prototype.render).toBe(render);
  });
});

describe("settings", () => {
  test("parse", () => {
    expect(parseMeasure("80")).toBe(80);
    expect(parseMeasure("off")).toBe(0);
    expect(parseMeasure("wide")).toBe(undefined);
  });

  test("env wins over the file, the file over the default", () => {
    const home = mkdtempSync(path.join(tmpdir(), "prose-width-"));
    expect(configuredMeasure({}, home)).toBe(80);
    mkdirSync(path.join(home, ".config/agents"), { recursive: true });
    writeFileSync(path.join(home, ".config/agents/prose-width.json"), '{ "width": 66 }');
    expect(configuredMeasure({}, home)).toBe(66);
    expect(configuredMeasure({ PROSE_WIDTH: "off" }, home)).toBe(0);
  });
});
