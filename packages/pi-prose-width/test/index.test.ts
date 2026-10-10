import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Markdown, type MarkdownTheme, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test } from "vitest";
import { configuredMeasure, install, parseMeasure } from "../src/index.ts";

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
