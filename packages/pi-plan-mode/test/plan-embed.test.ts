import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import zlib from "node:zlib";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
  theme as piTheme,
  setTerminalColors,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { LanesPage } from "../src/app/lanes-page.js";
import { PiChat, piChatTheme } from "../src/app/pi-chat.js";
import {
  type Capture,
  type CaptureOptions,
  capturePage,
  deleteImage,
  displayScale,
  type EmbedSize,
  frameMedium,
  type HostFrame,
  kittyImage,
  MAX_EMBED_CELLS,
  type PlanRenders,
  pageGeometry,
  placeholderLine,
  placeholderLines,
  RenderedPlans,
} from "../src/app/plan-embed.js";
import {
  embedColors,
  escapeHtml,
  pageStyle,
  parseGhosttyFont,
  planHtml,
  READY_TITLE,
  stripFrontMatter,
} from "../src/app/plan-html.js";
import type { PlannerAgent } from "../src/planner/agent.js";
import { PlannerTrace } from "../src/planner-trace.js";
import { normalizePlanModeSettings, updatePlanModeSettings } from "../src/settings.js";
import { SubagentTracker } from "../src/subagent-progress.js";

initTheme("dark");

const PLACEHOLDER = "\u{10EEEE}";
const ESC = "\x1b";

test("placeholder lines name every cell of the image and measure one column per cell", () => {
  const lines = placeholderLines(0x12ab34, 5, 3);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.equal(visibleWidth(line), 5);
    assert.ok(line.startsWith("\x1b[38;2;18;171;52m"), "the image id is the foreground colour");
    assert.equal([...line.matchAll(new RegExp(PLACEHOLDER, "gu"))].length, 5);
  }
  assert.notEqual(lines[0], lines[1], "each row carries its own row diacritic");
  assert.equal(placeholderLines(1, MAX_EMBED_CELLS + 50, 1)[0]?.split(PLACEHOLDER).length, MAX_EMBED_CELLS + 1);
  assert.deepEqual(placeholderLines(7, 4, 2, 3), [placeholderLine(7, 4, 3), placeholderLine(7, 4, 4)]);
  const full = placeholderLine(7, 3, 0).split(PLACEHOLDER);
  const shifted = placeholderLine(7, 2, 0, 1).split(PLACEHOLDER);
  assert.deepEqual(shifted.slice(1), full.slice(2), "from a column on: the same cells, less the first");
});

/** A stand-in for terminal-browser: joins the socket, logs what it gets, says it is ready (or not). */
function stubBrowser(mode: "ready" | "silent" | "exit") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-embed-test-"));
  const log = path.join(dir, "log.jsonl");
  const script = path.join(dir, "terminal-browser");
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
const net = require("net"), fs = require("fs");
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), tty: process.env.PIXEL_TTY, noMerge: process.env.TERMINAL_BROWSER_NO_MERGE, scale: process.env.PIXEL_DISPLAY_SCALE }) + "\\n");
if (${JSON.stringify(mode)} === "exit") { process.stderr.write("boom\\n"); process.exit(3); }
const conn = net.connect(process.env.PIXEL_EMBED, () => conn.write(JSON.stringify({ type: "join" }) + "\\n"));
const send = (message) => conn.write(JSON.stringify(message) + "\\n");
let n = 0;
const frame = () => send({ type: "frame", shm: "/px-9-1-" + ++n, format: "rgba", width: 420, height: 2400, generation: n, cols: 42, rows: 120, cell: [10, 20] });
let buf = "";
conn.on("data", (data) => {
  buf += data;
  let at;
  while ((at = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, at);
    buf = buf.slice(at + 1);
    fs.appendFileSync(log, line + "\\n");
    const message = JSON.parse(line);
    if (message.type === "init" && ${JSON.stringify(mode)} === "ready") {
      frame();
      send({ type: "title", text: "Plan" });
      setTimeout(() => { send({ type: "title", text: ${JSON.stringify(READY_TITLE)} + " 900 407 2354 1" }); setInterval(frame, 30); }, 50);
    }
  }
});
conn.on("close", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const messages = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return { dir, script, messages, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function until(check: () => boolean, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a capture opens the page embedded, waits for it to say it is ready, and keeps a later frame", async () => {
  const stub = stubBrowser("ready");
  try {
    const capture = await capturePage({
      file: "/tmp/plan.html",
      cols: 42,
      rows: 120,
      command: stub.script,
      tty: "/dev/ttys999",
    });
    capture.release();
    const [launch, init] = stub.messages();
    assert.deepEqual(launch?.argv, ["open", "/tmp/plan.html"]);
    assert.equal(launch?.tty, "/dev/ttys999");
    assert.equal(launch?.noMerge, "1", "never merges into a browser beside the pane");
    assert.ok(Number(launch?.scale) >= 1, "and draws at the terminal's scale, not the pointer's screen's");
    assert.equal(init?.type, "init");
    assert.equal(init?.transport, "host", "the frames come to Pi");
    assert.equal(init?.cols, 42);
    assert.equal(init?.rows, 120);
    assert.deepEqual(capture.page, { height: 900, windowWidth: 407, windowHeight: 2354, ratio: 1 });
    assert.notEqual(capture.frame.shm, "/px-9-1-1", "not the frame from before the page was ready");
    assert.deepEqual(capture.frame.cell, [10, 20]);
  } finally {
    stub.cleanup();
  }
});

test("a capture that never gets ready, or whose browser exits, fails", async () => {
  const silent = stubBrowser("silent");
  const exiting = stubBrowser("exit");
  try {
    await assert.rejects(
      capturePage({ file: "/tmp/p.html", cols: 4, rows: 2, command: silent.script, tty: "/dev/null", timeoutMs: 300 }),
      /did not show the page in time/u,
    );
    await assert.rejects(
      capturePage({ file: "/tmp/p.html", cols: 4, rows: 2, command: exiting.script, tty: "/dev/null" }),
      /boom/u,
    );
    await assert.rejects(
      capturePage({
        file: "/tmp/p.html",
        cols: 4,
        rows: 2,
        command: "",
        tty: "/dev/null",
        env: { PI_PLAN_MODE_TERMINAL_BROWSER: "" },
      }),
      /not installed/u,
    );
  } finally {
    silent.cleanup();
    exiting.cleanup();
  }
});

test("the lane shows only the cells wholly inside the page, below the browser's toolbar", () => {
  // 120 rows of 20px; the toolbar (42px) and bottom margin (4px) take 46px, the side margins 13px.
  const frame: HostFrame = { shm: "/x", width: 420, height: 2400, cols: 42, rows: 120, cell: [10, 20] };
  const geometry = pageGeometry(frame, { height: 900, windowWidth: 407, windowHeight: 2354, ratio: 1 });
  const { hiddenTop, ...cells } = geometry;
  assert.deepEqual(cells, { firstRow: 3, rows: 116, firstCol: 1, cols: 39, rowCss: 20 });
  assert.ok(Math.abs(hiddenTop - 18) < 1e-9, "18px of the page are under the first row shown");
  const retina = pageGeometry(
    { shm: "/x", width: 840, height: 4800, cols: 42, rows: 120, cell: [20, 40] },
    { height: 900, windowWidth: 407, windowHeight: 2354, ratio: 2 },
  );
  assert.equal(retina.rowCss, 20, "rows in CSS pixels at a 2x pixel ratio");
  assert.equal(retina.firstRow, 3);
});

test("a frame goes to the terminal by name in shared memory, or inline from /dev/shm", () => {
  const frame: HostFrame = { shm: "/px-1-2-3", width: 2, height: 1, cols: 1, rows: 1 };
  assert.equal(
    kittyImage(frame, 0x100001, "shared"),
    `\x1b_Ga=T,t=s,f=32,s=2,v=1,i=${0x100001},U=1,c=1,r=1,q=2;${Buffer.from("/px-1-2-3").toString("base64")}\x1b\\`,
  );
  const pixels = Buffer.from([1, 2, 3, 255, 4, 5, 6, 255, 9, 9, 9, 9]);
  let read = "";
  const inline = kittyImage(frame, 7, "inline", (name) => {
    read = name;
    return pixels;
  });
  assert.equal(read, "/px-1-2-3");
  const match = new RegExp(`^${ESC}_Ga=T,o=z,f=32,s=2,v=1,i=7,U=1,c=1,r=1,q=2,m=0;([^${ESC}]*)${ESC}\\\\$`, "u").exec(
    inline,
  );
  assert.ok(match, inline);
  assert.deepEqual(
    zlib.inflateSync(Buffer.from(match[1] ?? "", "base64")),
    pixels.subarray(0, 8),
    "just the frame's pixels",
  );
  assert.equal(deleteImage(7), "\x1b_Ga=d,d=I,i=7,q=2\x1b\\");
  assert.equal(displayScale({}, 37), 2, "Retina cells: twice the pixels per CSS pixel");
  assert.equal(displayScale({}, 18), 1);
  assert.equal(displayScale({}, 28), 1.5);
  assert.equal(displayScale({ PI_PLAN_MODE_SCALE: "3" }, 37), 3);
  assert.equal(frameMedium({ HERDR_ENV: "1", SSH_CONNECTION: "x" }), "shared", "herdr reads shared memory here");
  assert.equal(frameMedium({}), "shared");
  assert.equal(frameMedium({ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }), "inline", "a terminal elsewhere gets pixels");
  assert.equal(frameMedium({ HERDR_ENV: "1", PI_PLAN_MODE_FRAMES: "inline" }), "inline");
});

/** Captures for RenderedPlans: the geometry test's frame, with a page `height` CSS pixels tall. */
function fakeCaptures(height: () => number, fail?: () => boolean) {
  const calls: { options: CaptureOptions; html: string; released: boolean }[] = [];
  const capture = async (options: CaptureOptions): Promise<Capture> => {
    const call = { options, html: fs.readFileSync(options.file, "utf8"), released: false };
    calls.push(call);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (fail?.()) throw new Error("no luck");
    return {
      frame: {
        shm: `/px-${calls.length}`,
        width: options.cols * 10,
        height: options.rows * 20,
        cols: options.cols,
        rows: options.rows,
        cell: [10, 20],
      },
      page: { height: height(), windowWidth: options.cols * 10 - 13, windowHeight: options.rows * 20 - 46, ratio: 1 },
      release: () => {
        call.released = true;
      },
    };
  };
  return { calls, capture };
}

const IMAGE = new RegExp(`${ESC}_Ga=T,t=s,[^;]*i=(\\d+),`, "u");
const DELETE = new RegExp(`${ESC}_Ga=d,d=I,i=(\\d+),`, "gu");

/** The image id and image row a placeholder line names (its colour and first row diacritic). */
function cell(line: string | undefined): { image: number; row: string } {
  const color = new RegExp(`${ESC}\\[38;2;(\\d+);(\\d+);(\\d+)m`, "u").exec(line ?? "");
  const [, r, g, b] = (color ?? []).map(Number);
  return { image: ((r ?? 0) << 16) | ((g ?? 0) << 8) | (b ?? 0), row: (line ?? "").split(PLACEHOLDER)[1]?.[0] ?? "" };
}

test("a page is captured in stacked images as the lane scrolls to them, within an image budget", async () => {
  // 32-row captures of 20px rows: the toolbar and margins leave 28 page rows each, the first 18px
  // of the page hidden. 300 page rows: 11 chunks, of which only those near the lane are captured.
  let height = 18 + 300 * 20;
  const { calls, capture } = fakeCaptures(() => height);
  const written: string[] = [];
  let changes = 0;
  let enabled = true;
  let style = "light";
  const chunkBytes = 43 * 10 * 640 * 4;
  const renders = new RenderedPlans({
    enabled: () => enabled,
    styleKey: () => style,
    html: async (plan, id) => `<p>${id}: ${plan}</p><script>window.PI_SHIFT = 0;</script>`,
    onChange: () => changes++,
    write: (data) => written.push(data),
    capture,
    env: { HERDR_ENV: "1" },
    budgetBytes: chunkBytes * 4,
  });
  const images = () => written.flatMap((data) => (IMAGE.exec(data) ? [Number(IMAGE.exec(data)?.[1])] : []));
  const deleted = () => written.flatMap((data) => [...data.matchAll(DELETE)].map((match) => Number(match[1])));
  const shifts = () => calls.map((call) => Number(/PI_SHIFT = ([\d.]+);/u.exec(call.html)?.[1]));
  const draw = (rows = 10) => {
    renders.beginFrame();
    return renders.body("A", 1, "plan one", { cols: 40, rows }) ?? [];
  };
  try {
    assert.equal(renders.body("A", 1, "plan one", { cols: 40, rows: 10 }), undefined, "the page is being captured");
    await until(() => changes > 0);
    assert.deepEqual(renders.position("A"), { first: 1, last: 10, total: 300 }, "the first capture measures the page");
    assert.ok(
      calls.every((call) => call.options.cols === 43 && call.options.rows === 32),
      "a browser a little wider",
    );
    const top = draw();
    assert.equal(top.length, 10);
    assert.equal(visibleWidth(top[0] ?? ""), 40);
    assert.equal(cell(top[0]).image, images()[0]);
    await until(() => calls.length === 2);
    assert.deepEqual(shifts(), [0, 560], "and the next chunk down, moved up by the 28 rows before it");

    renders.scroll("A", 110);
    const blank = draw();
    assert.equal(blank[0], "", "a chunk not captured yet shows blank for a moment");
    await until(() => calls.length === 5);
    assert.deepEqual(shifts().slice(2).sort(), [1680, 2240, 2800], "rows 111-120 are in chunks 3 and 4; 5 is next");
    await until(() => images().length === 5);
    const across = draw();
    assert.notEqual(cell(across[0]).image, cell(across[9]).image, "the lane spans two chunks");
    assert.equal(cell(across[2]).row, cell(top[0]).row, "row 113 is the top page row of its chunk (4 × 28)");
    assert.notEqual(cell(across[1]).image, cell(across[2]).image);
    assert.ok(deleted().length >= 1, "chunks far from the lane are freed to stay in the budget");
    assert.ok(!deleted().includes(cell(across[0]).image) && !deleted().includes(cell(across[9]).image));

    renders.scroll("A", Number.POSITIVE_INFINITY);
    draw();
    assert.deepEqual(renders.position("A"), { first: 291, last: 300, total: 300 }, "End stops at the last row");
    renders.scroll("A", -1_000_000);
    assert.deepEqual(renders.position("A"), { first: 1, last: 10, total: 300 });
    assert.equal(renders.scroll("B", 4), false, "no page, so the lane scrolls itself");
    renders.beginFrame();
    assert.equal(renders.scroll("A", 1), false, "nor does a page the last frame did not draw");

    height = 18 + 20 * 20;
    renders.body("A", 2, "plan two", { cols: 40, rows: 10 });
    const before = images().length;
    await until(() => renders.position("A")?.total === 20);
    const shown = new Set(images().slice(0, before));
    assert.ok(
      [...shown].every((image) => deleted().includes(image)),
      "a new revision frees every old image",
    );

    style = "dark";
    const count = calls.length;
    draw();
    await until(() => calls.length > count);
    assert.equal(calls.length, count + 1, "new colours capture it again");

    enabled = false;
    assert.equal(renders.body("A", 2, "plan two", { cols: 40, rows: 10 }), undefined, "off: terminal Markdown");
  } finally {
    renders.dispose();
  }
  const kept = images().filter((image) => !deleted().includes(image));
  assert.deepEqual(kept, [], "closing frees every image");
  assert.ok(
    calls.every((call) => !fs.existsSync(call.options.file)),
    "and deletes its page files",
  );
});

test("a newer page shows once captured, a failed one leaves the old page up, and a resize waits", async () => {
  let fail = false;
  const { calls, capture } = fakeCaptures(
    () => 18 + 20 * 20,
    () => fail,
  );
  const written: string[] = [];
  const renders = new RenderedPlans({
    enabled: () => true,
    html: async (plan) => plan,
    onChange: () => undefined,
    write: (data) => written.push(data),
    capture,
  });
  try {
    renders.body("A", 1, "one", { cols: 40, rows: 5 });
    await until(() => renders.position("A") !== undefined);
    const first = renders.body("A", 1, "one", { cols: 40, rows: 5 });
    fail = true;
    renders.body("A", 2, "two", { cols: 40, rows: 5 });
    assert.deepEqual(renders.body("A", 2, "two", { cols: 40, rows: 5 }), first, "the old page while the new one loads");
    await until(() => calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(renders.body("A", 2, "two", { cols: 40, rows: 5 }), first, "still up after the new one failed");
    assert.equal(renders.failure("A"), undefined, "no failure note while a page shows");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, 2, "a failed page is not tried again every frame");

    fail = false;
    renders.body("B", 1, "bee", { cols: 40, rows: 5 });
    await until(() => renders.position("B") !== undefined);
    const captures = calls.length;
    for (const cols of [38, 36, 34]) renders.body("B", 1, "bee", { cols, rows: 5 });
    assert.equal(visibleWidth(renders.body("B", 1, "bee", { cols: 34, rows: 5 })?.[0] ?? ""), 34, "cropped meanwhile");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls.length, captures, "not while the lane is still being resized");
    await until(() => calls.length === captures + 1, 2000);
    assert.equal(calls.at(-1)?.options.cols, 37, "then once, at the width it settled on");

    fail = true;
    renders.body("C", 1, "sea", { cols: 40, rows: 5 });
    await until(() => renders.failure("C") !== undefined);
    assert.equal(renders.failure("C"), "no luck", "a lane without a page says why");
  } finally {
    renders.dispose();
  }
});

function fakeAgent(id: string, extra: Partial<PlannerAgent> = {}): PlannerAgent {
  const chat = new PiChat(piChatTheme, { cwd: "/" });
  chat.note(`chat of ${id}`);
  return {
    id,
    chat,
    name: `Model ${id}`,
    spec: { provider: "p", modelId: id, thinkingLevel: "high" },
    trace: new PlannerTrace(),
    subagents: new SubagentTracker(id),
    status: "idle",
    working: false,
    stats: { startedAt: 0, endedAt: 1000, toolCalls: 0, subagentTasks: 0, totalTokens: 0, costUsd: 0 },
    revision: 0,
    lastReply: "",
    pending: undefined,
    plan: undefined,
    answer: () => undefined,
    ...extra,
  } as unknown as PlannerAgent;
}

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as never;

test("a lane with a rendered plan draws its page, scrolls it by rows, and goes back to text in chat view", () => {
  const scrolled: [string, number][] = [];
  const sizes: EmbedSize[] = [];
  let frames = 0;
  let failure: string | undefined;
  const renders: PlanRenders = {
    enabled: () => true,
    body: (id, _revision, _plan, size) => {
      sizes.push(size);
      return id === "A" ? placeholderLines(0x100002, size.cols, size.rows) : undefined;
    },
    position: (id) => (id === "A" ? { first: 1, last: 20, total: 64 } : undefined),
    failure: (id) => (id === "B" ? failure : undefined),
    scroll: (id, rows) => {
      scrolled.push([id, rows]);
      return id === "A";
    },
    beginFrame: () => frames++,
    endFrame: () => undefined,
    hideAll: () => undefined,
    dispose: () => undefined,
  };
  const a = fakeAgent("A", { plan: "# Plan A\n\nDo it.", revision: 1 } as never);
  const b = fakeAgent("B", { plan: "# Plan B\n\nDo that.", revision: 1 } as never);
  const page = new LanesPage(plainTheme, {
    title: "Plan",
    task: () => "add a cache",
    agents: () => [a, b],
    actions: () => [],
    onAction: () => undefined,
    say: () => undefined,
    hide: () => undefined,
    stopAll: () => undefined,
    rowsAvailable: () => 30,
    requestRender: () => undefined,
    renders,
  });
  failure = "terminal-browser is not installed";
  let lines = page.render(120);
  assert.equal(frames, 1);
  assert.equal(lines.length, 30);
  const withPage = lines.filter((line) => line.includes(PLACEHOLDER));
  assert.ok(withPage.length >= 5, "A's body is the page");
  assert.ok(sizes.length >= 2 && (sizes[0]?.cols ?? 0) > 20, "each lane asks for a page its body's size");
  assert.ok(
    lines.some((line) => line.includes("1–20/64")),
    "and says where in the page it is",
  );
  assert.ok(
    lines.some((line) => stripVTControlCharacters(line).includes("Plan B")),
    "B, without a page, keeps its Markdown",
  );
  assert.ok(
    lines.some((line) => line.includes("not rendered: terminal-browser")),
    "and says why",
  );
  assert.ok(
    lines.some((line) => line.includes("A \u00b7 Model A high") && line.includes("plan ready")),
    "in Review the lane titles carry the status",
  );
  assert.ok(
    !lines.some((line) => /^ \S A {1,2}Model A/u.test(stripVTControlCharacters(line))),
    "and the stats table is gone",
  );

  page.handleInput("\x1b[6~"); // pageDown in A, the focused lane
  page.handleInput("\x1b[B"); // down
  page.handleInput("\x04"); // ctrl+d
  page.handleInput("\x1b[F"); // end
  page.handleInput("\x1b[H"); // home
  assert.equal(scrolled.length, 5, "the page scrolls by the lane's rows");
  assert.ok((scrolled[0]?.[1] ?? 0) > 1, "a page down scrolls a lane's height");
  assert.deepEqual(scrolled[1], ["A", 1]);
  assert.ok((scrolled[2]?.[1] ?? 0) > 1 && (scrolled[2]?.[1] ?? 0) < (scrolled[0]?.[1] ?? 0), "ctrl+d half of it");
  assert.ok((scrolled[3]?.[1] ?? 0) > 1000 && (scrolled[4]?.[1] ?? 0) < -1000, "end and home to the ends");

  // Pi's own bindings, as keybindings.json sets them: ctrl+k/ctrl+j up and down, ctrl+g to the bottom.
  const saved = getKeybindings();
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": ["up", "ctrl+k"],
      "tui.select.down": ["down", "ctrl+j"],
      "tui.altScreen.bottom": ["ctrl+g", "ctrl+end"],
    }),
  );
  try {
    scrolled.length = 0;
    page.handleInput("\x0b"); // ctrl+k
    page.handleInput("\n"); // ctrl+j
    page.handleInput("\x07"); // ctrl+g
    assert.deepEqual(scrolled.slice(0, 2), [
      ["A", -1],
      ["A", 1],
    ]);
    assert.ok((scrolled[2]?.[1] ?? 0) > 1000, "ctrl+g to the bottom");
  } finally {
    setKeybindings(saved);
  }

  page.handleInput("\x1b[C"); // → to A's chat
  lines = page.render(120);
  assert.ok(!lines.some((line) => line.split("│")[0]?.includes(PLACEHOLDER)), "the chat replaces the page");
  assert.ok(lines.some((line) => line.includes("chat of A")));
  const before = scrolled.length;
  page.handleInput("\x1b[B");
  assert.equal(scrolled.length, before, "in chat view the lane scrolls its own lines");
});

test("a page is white with its own palette until the terminal reports its background, then blends in", () => {
  setTerminalColors({});
  const white = pageStyle(piTheme);
  assert.equal(white.dark, false);
  assert.equal(white.colors.background, "#ffffff");
  assert.equal(white.colors.text, "#1f2328", "not the dark theme's light text on white");
  setTerminalColors({ background: { r: 30, g: 31, b: 32 }, foreground: { r: 200, g: 201, b: 202 } });
  try {
    const matched = pageStyle(piTheme);
    assert.equal(matched.dark, true);
    assert.equal(matched.colors.background, "#1e1f20", "the terminal's own background");
    assert.notEqual(matched.colors.surface, matched.colors.background, "code blocks stand out from it");
    assert.deepEqual(embedColors(piTheme).background, [30, 31, 32, 255], "and the browser's matches while it loads");
    setTerminalColors({ background: { r: 250, g: 250, b: 245 }, foreground: { r: 20, g: 20, b: 20 } });
    const light = pageStyle(piTheme);
    assert.equal(light.dark, false);
    assert.equal(light.colors.background, "#fafaf5");
    assert.equal(light.colors.text, "#1f2328", "a dark theme on a light terminal uses the light palette");
  } finally {
    setTerminalColors({});
  }
});

test("a plan page shows code, tables, callouts and Mermaid diagrams, and says when it is ready", async () => {
  const theme = piTheme;
  const markdown = [
    "---",
    "title: hidden",
    "---",
    "# Rate limiting",
    "",
    "| Step | Owner |",
    "|---|---|",
    "| D-01 | API team |",
    "",
    "```ts",
    "const limit = 10;",
    "```",
    "",
    "```mermaid",
    "graph LR",
    "  A --> B",
    "```",
    "",
    "- [x] done",
    "",
    "> [!WARNING]",
    "> Redis is a **single** point of failure.",
    "",
    "> plain quote",
    "",
    '<script>alert("x")</script>',
  ].join("\n");
  const html = await planHtml(markdown, theme, "Plan <A>", {
    mono: 'JetBrains "Mono"',
    mermaid: "file:///m/mermaid.min.js",
  });
  assert.match(html, /<title>Plan &lt;A&gt;<\/title>/u);
  assert.doesNotMatch(html, /title: hidden/u, "front matter is left out");
  assert.match(html, /<h1[^>]*>Rate limiting<\/h1>/u);
  assert.match(html, /<div class="table-wrap"><table>/u, "tables sit in a frame they fill");
  assert.match(html, /<td><span class="nowrap">D-01<\/span><\/td>/u, "a cell without spaces does not break");
  assert.match(html, /<td>API team<\/td>/u);
  assert.match(
    html,
    /<div class="alert alert-warning"><p class="alert-title">Warning<\/p>\s*<p>Redis is a <strong>single<\/strong> point of failure\.<\/p>/u,
    "a GitHub alert becomes a callout, without its marker",
  );
  assert.doesNotMatch(html, /\[!WARNING\]/u);
  assert.match(html, /<blockquote>\s*<p>plain quote<\/p>/u, "other quotes stay quotes");
  assert.match(html, /class="shiki/u, "code is highlighted");
  assert.match(html, /<pre class="mermaid">graph LR\n {2}A --&gt; B\n?<\/pre>/u, "Mermaid draws the diagram");
  assert.match(html, /class="mermaid-fallback" hidden><pre class="diagram">/u, "with the text art kept for a failure");
  assert.match(html, /<script src="file:\/\/\/m\/mermaid\.min\.js"><\/script>/u, "from the bundled script");
  assert.match(html, /mermaid\?\.initialize\(\{"startOnLoad":false/u);
  assert.match(html, /--mono: "JetBrains Mono", ui-monospace/u, "code in the terminal's font");
  assert.match(html, new RegExp(`${READY_TITLE}`, "u"), "the page says when it is ready");
  assert.match(html, /window\.PI_SHIFT = 0;/u, "and can be moved up for a later capture");
  assert.match(html, /type="checkbox"/u);
  assert.match(html, /--background: #ffffff/u);
  assert.match(html, /color: var\(--shiki-light\)/u, "a light page picks the light highlight");
  assert.doesNotMatch(html, /<script>alert/u, "raw HTML is shown as text");
  assert.match(html, /&lt;script&gt;alert/u);
  assert.doesNotMatch(html, /(src|href)=["']https?:/u, "nothing comes from the network");
  const plain = await planHtml("```mermaid\ngraph LR\n  A --> B\n```", theme, "P", { mono: "", mermaid: false });
  assert.match(plain, /<pre class="diagram">/u, "without Mermaid, diagrams are text art");
  assert.doesNotMatch(plain, /<script src=/u);
  assert.doesNotMatch(plain, /mermaid\?\.initialize/u);
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("the code font comes from Ghostty's config, and front matter of either kind is dropped", () => {
  assert.equal(
    parseGhosttyFont("font-size = 14\nfont-family = \nfont-family = JetBrains Mono\nfont-family = Symbols"),
    "JetBrains Mono",
  );
  assert.equal(parseGhosttyFont('font-family = "Iosevka Term"'), "Iosevka Term");
  assert.equal(parseGhosttyFont("theme = x"), undefined);
  assert.equal(stripFrontMatter("+++\na = 1\n+++\n# Plan"), "# Plan");
  assert.equal(stripFrontMatter("# Plan\n---\nnot front matter\n---\n"), "# Plan\n---\nnot front matter\n---\n");
});

test("renderedPlans is a boolean setting that round-trips", async () => {
  assert.equal(normalizePlanModeSettings({ renderedPlans: false })?.renderedPlans, false);
  assert.equal(normalizePlanModeSettings({ renderedPlans: "no" }), undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-settings-"));
  const settingsPath = path.join(dir, "pi-plan-mode.json");
  try {
    await updatePlanModeSettings({ renderedPlans: false }, { settingsPath });
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).renderedPlans, false);
    await updatePlanModeSettings({ renderedPlans: null }, { settingsPath });
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(settingsPath, "utf8")), "renderedPlans"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
