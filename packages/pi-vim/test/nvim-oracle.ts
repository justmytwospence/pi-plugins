import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModalEditor } from "../src/index.js";
import type { ModalEditorOptions } from "../src/engine/modal-editor.js";
import { stubKeybindings, stubTheme, stubTui } from "./harness.js";

export type NvimParityMode = "normal" | "insert" | "visual" | "visual-line";

/** The lua driver can only seed the buffer in one of these two modes. */
export type NvimParityInitialMode = "normal" | "insert";

export type NvimParityCursor = {
  line: number;
  col: number;
};

export type NvimParityInitialState = {
  text: string;
  cursor: NvimParityCursor;
  mode?: NvimParityInitialMode;
  register?: string;
};

/** Vim plugins a case runs with: loaded in Neovim, enabled in pi-vim. */
export type NvimParityPlugin = "targets" | "surround" | "wordmotion";

export type NvimParityCase = {
  name: string;
  initial: NvimParityInitialState;
  keys: string[];
  plugins?: NvimParityPlugin[];
  /** Ex commands Neovim runs before the keys (e.g. `set sw=2 et`). */
  setup?: string[];
};

const PLUGIN_DIRS: Record<NvimParityPlugin, string[]> = {
  targets: ["targets.vim"],
  surround: ["vim-repeat", "vim-surround"],
  wordmotion: ["vim-wordmotion"],
};

/** Where the Vim plugins are checked out (`PI_VIM_PLUGIN_DIR`, else ~/.vim/plugins). */
export const VIM_PLUGIN_DIR = process.env.PI_VIM_PLUGIN_DIR ?? join(homedir(), ".vim", "plugins");

function pluginPaths(plugins: NvimParityPlugin[] = []): string[] {
  return plugins.flatMap((plugin) => PLUGIN_DIRS[plugin].map((dir) => join(VIM_PLUGIN_DIR, dir)));
}

/** True when every plugin a case needs is installed, so the oracle can load it. */
export function pluginsAvailable(plugins: NvimParityPlugin[] = []): boolean {
  return pluginPaths(plugins).every((path) => existsSync(path));
}

function piOptionsFor(plugins: NvimParityPlugin[] = []): ModalEditorOptions {
  return {
    targets: plugins.includes("targets"),
    surround: plugins.includes("surround"),
    wordMotion: plugins.includes("wordmotion"),
    shiftWidth: 2,
  };
}

export type NvimParitySnapshot = {
  text: string;
  cursor: NvimParityCursor;
  mode: NvimParityMode;
  register: string;
};

type ModalEditorMutable = {
  state?: {
    lines?: string[];
    cursorLine?: number;
    cursorCol?: number;
  };
  preferredVisualCol?: number | null;
  tui?: {
    requestRender?: () => void;
  };
};

type RawNvimSnapshot = {
  text: string;
  cursor: NvimParityCursor;
  mode: string;
  register: string;
};

const NVIM_RESULT_PREFIX = "PI_VIM_NVIM_RESULT:";

const NVIM_MODE_MAP: Record<string, NvimParityMode> = {
  n: "normal",
  no: "normal",
  niI: "normal",
  niR: "normal",
  niV: "normal",
  nt: "normal",
  i: "insert",
  ic: "insert",
  ix: "insert",
  R: "insert",
  Rc: "insert",
  Rv: "insert",
  v: "visual",
  V: "visual-line",
};

const NVIM_DRIVER_LUA = [
  "local input = vim.json.decode(vim.env.PI_VIM_NVIM_SCENARIO)",
  "for _, p in ipairs(input.plugins) do vim.opt.rtp:prepend(p) end",
  "for _, p in ipairs(input.plugins) do for _, f in ipairs(vim.fn.globpath(p, 'plugin/*.vim', 0, 1)) do vim.cmd('source ' .. vim.fn.fnameescape(f)) end end",
  // Neovim 0.12's default `in`/`an` selection maps would shadow targets.vim's `n`.
  "if #input.plugins > 0 then for _, m in ipairs({'in', 'an'}) do pcall(vim.keymap.del, {'o', 'x'}, m) end end",
  "for _, c in ipairs(input.setup) do vim.cmd(c) end",
  "local lines = vim.split(input.text, '\\n', { plain = true })",
  "if #lines == 0 then lines = { '' } end",
  "vim.api.nvim_buf_set_lines(0, 0, -1, true, lines)",
  "vim.fn.setreg('\"', input.register or '')",
  "vim.api.nvim_win_set_cursor(0, { input.cursor.line + 1, input.cursor.col })",
  "if input.mode == 'insert' then vim.cmd('startinsert') else vim.cmd('stopinsert') end",
  "vim.api.nvim_win_set_cursor(0, { input.cursor.line + 1, input.cursor.col })",
  "local keys = table.concat(input.keys, '')",
  "local term = vim.api.nvim_replace_termcodes(keys, true, false, true)",
  "vim.api.nvim_feedkeys(term, 'x', false)",
  "local out_lines = vim.api.nvim_buf_get_lines(0, 0, -1, true)",
  "local cursor = vim.api.nvim_win_get_cursor(0)",
  "local snapshot = { text = table.concat(out_lines, '\\n'), cursor = { line = cursor[1] - 1, col = cursor[2] }, mode = vim.api.nvim_get_mode().mode, register = vim.fn.getreg('\"') }",
  `print('${NVIM_RESULT_PREFIX}' .. vim.json.encode(snapshot))`,
  "vim.cmd('qa!')",
].join("; ");

function toNvimKey(key: string): string {
  switch (key) {
    case "\x1b":
      return "<Esc>";
    case "\n":
      return "<CR>";
    case "\r":
      return "<CR>";
    case "\t":
      return "<Tab>";
    default:
      return key;
  }
}

function normalizeNvimMode(mode: string): NvimParityMode {
  const normalized = NVIM_MODE_MAP[mode];
  if (!normalized) {
    throw new Error(`unsupported nvim mode in parity snapshot: ${mode}`);
  }
  return normalized;
}

function assertSnapshot(value: unknown): asserts value is RawNvimSnapshot {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);

  const snapshot = value as Record<string, unknown>;
  assert.equal(typeof snapshot.text, "string");
  assert.equal(typeof snapshot.mode, "string");
  assert.equal(typeof snapshot.register, "string");
  assert.equal(typeof snapshot.cursor, "object");
  assert.notEqual(snapshot.cursor, null);

  const cursor = snapshot.cursor as Record<string, unknown>;
  assert.equal(typeof cursor.line, "number");
  assert.equal(typeof cursor.col, "number");
}

function setPiCursor(editor: ModalEditor, cursor: NvimParityCursor): void {
  const mutable = editor as unknown as ModalEditorMutable;
  const state = mutable.state;
  if (!state || !Array.isArray(state.lines)) {
    throw new Error("ModalEditor state is unavailable");
  }

  const maxLine = Math.max(0, state.lines.length - 1);
  const line = Math.max(0, Math.min(cursor.line, maxLine));
  const lineText = state.lines[line] ?? "";
  const col = Math.max(0, Math.min(cursor.col, lineText.length));

  state.cursorLine = line;
  state.cursorCol = col;
  mutable.preferredVisualCol = col;
  mutable.tui?.requestRender?.();
}

function takePiSnapshot(editor: ModalEditor): NvimParitySnapshot {
  const cursor = editor.getCursor();
  return {
    text: editor.getText(),
    cursor: { line: cursor.line, col: cursor.col },
    mode: editor.getMode(),
    register: editor.getRegister(),
  };
}

export function runPiParityCase(testCase: NvimParityCase): NvimParitySnapshot {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings, piOptionsFor(testCase.plugins));
  editor.setClipboardFn(() => undefined);
  editor.setClipboardReadFn(() => null);
  editor.setText(testCase.initial.text);
  editor.setRegister(testCase.initial.register ?? "");

  if ((testCase.initial.mode ?? "normal") === "normal") {
    editor.handleInput("\x1b");
  }

  setPiCursor(editor, testCase.initial.cursor);

  for (const key of testCase.keys) {
    editor.handleInput(key);
  }

  return takePiSnapshot(editor);
}

export async function runNvimParityCase(
  testCase: NvimParityCase,
): Promise<NvimParitySnapshot> {
  const scenario = {
    text: testCase.initial.text,
    cursor: testCase.initial.cursor,
    mode: testCase.initial.mode ?? "normal",
    register: testCase.initial.register ?? "",
    keys: testCase.keys.map(toNvimKey),
    plugins: pluginPaths(testCase.plugins),
    setup: testCase.setup ?? [],
  };

  const child = spawn(
    "nvim",
    [
      "--clean",
      "--headless",
      "-n",
      "-i",
      "NONE",
      "-u",
      "NONE",
      "-c",
      `lua ${NVIM_DRIVER_LUA}`,
    ],
    {
      env: {
        ...process.env,
        PI_VIM_NVIM_SCENARIO: JSON.stringify(scenario),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (exit.code !== 0) {
    throw new Error(
      `nvim parity oracle failed for ${testCase.name} (code=${exit.code}, signal=${String(exit.signal)}, stderr=${JSON.stringify(stderr.trim())})`,
    );
  }

  const combinedOutput = `${stdout}\n${stderr}`;
  // Messages such as a search pattern echo can precede the result on its line.
  const resultLine = combinedOutput
    .split(/\r?\n/)
    .map((line) => line.slice(Math.max(0, line.indexOf(NVIM_RESULT_PREFIX))))
    .find((line) => line.startsWith(NVIM_RESULT_PREFIX));

  if (!resultLine) {
    throw new Error(
      `nvim parity oracle produced no result for ${testCase.name} (stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`,
    );
  }

  const parsed = JSON.parse(
    resultLine.slice(NVIM_RESULT_PREFIX.length),
  ) as unknown;
  assertSnapshot(parsed);

  return {
    text: parsed.text,
    cursor: parsed.cursor,
    mode: normalizeNvimMode(parsed.mode),
    register: parsed.register,
  };
}

export async function assertMatchesNvim(
  testCase: NvimParityCase,
): Promise<void> {
  const [pi, nvim] = await Promise.all([
    Promise.resolve(runPiParityCase(testCase)),
    runNvimParityCase(testCase),
  ]);

  assert.deepEqual(pi, nvim);
}
