import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters as plain } from "node:util";
import { test } from "vitest";

const modules = fileURLToPath(new URL("../node_modules/@earendil-works/", import.meta.url));
const root = path.join(modules, "pi-coding-agent");
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const tuiPath = path.join(modules, "pi-tui/dist/index.js");
const { createJiti } = await import(pathToFileURL(path.join(root, "dist/core/extensions/jiti-loader.js")));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-tui": tuiPath } });
const mod = await jiti.import(entry);
const { visibleWidth } = await import(pathToFileURL(tuiPath));
const { getThemeByName } = await import(pathToFileURL(path.join(root, "dist/modes/interactive/theme/theme.js")));
const now = Date.parse("2026-09-23T12:00:00Z");
const theme = { fg: (_color, text) => text, bold: (text) => text };
const usage = (cost = 1) => ({ input: 100, output: 20, cacheRead: 300, cacheWrite: 100, cost: { total: cost } });
const fixture = () => ({
  cwd: "/home/me/dotfiles", model: "claude-opus-5-5", provider: "anthropic", thinking: "xhigh", oauth: true,
  queued: false, context: { tokens: 56_000, contextWindow: 200_000, percent: 28 },
  totals: { input: 23000, output: 1500, cacheRead: 90000, cacheWrite: 400, cost: 1.24, compactions: 1, started: now - 80 * 60_000 },
  cacheHit: 94, git: { branch: "main", project: "dotfiles", staged: 0, changed: 2, untracked: 1, conflicts: 0, ahead: 2, behind: 0, added: 25, removed: 4 },
  quotas: [{ source: "Claude acct", updated: now, windows: [
    { label: "5h", used: 32, reset: now + 134 * 60_000 },
    { label: "week", used: 41, reset: now + 3 * 86400_000 },
    { label: "Fable", used: 68, reset: now + 3 * 86400_000 },
  ], extra: { enabled: false } }], statuses: [], now,
});

test("counts every recorded usage source without double counting", () => {
  const entries = [
    { type: "message", timestamp: new Date(now - 60_000).toISOString(), message: { role: "assistant", usage: usage(1) } },
    { type: "message", message: { role: "toolResult", usage: usage(2) } },
    { type: "usage", usage: usage(3) },
    { type: "compaction", usage: usage(4) },
    { type: "branch_summary", usage: usage(5) },
    { type: "message", message: { role: "user", usage: usage(999) } },
    { type: "custom", usage: usage(999) },
    { type: "message", message: { role: "assistant", usage: { input: NaN, output: -2, cost: { total: Infinity } } } },
  ];
  assert.deepEqual(mod.collectTotals(entries, now), { input: 500, output: 100, cacheRead: 1500, cacheWrite: 500, cost: 15, compactions: 1, started: now - 60_000 });
});

test("cache hit includes cache writes in denominator and respects branch/model", () => {
  const message = { role: "assistant", provider: "anthropic", model: "test", usage: usage() };
  assert.equal(mod.latestCacheHit([{ message }], "anthropic", "test"), 60);
  assert.equal(mod.latestCacheHit([{ message }], "openai-codex", "test"), undefined);
  assert.equal(mod.latestCacheHit([{ message }], "anthropic", "different"), undefined);
  assert.equal(mod.latestCacheHit([{ message }, { message: { ...message, usage: {} } }], "anthropic", "test"), 60);
});

test("Claude percentages are never heuristically multiplied, and scoped limits are generic", () => {
  const parsed = mod.parseClaudeQuota({
    five_hour: { utilization: 0.5, resets_at: "2026-09-23T14:00:00.488018+00:00" },
    limits: [
      { kind: "weekly_all", percent: 52 },
      { kind: "weekly_scoped", percent: 74, scope: { model: { display_name: "Fable" } } },
      { kind: "weekly_scoped", percent: 6, scope: { model: { display_name: "Future model" } } },
      { kind: "weekly_scoped", percent: "bad", scope: {} },
    ],
    spend: { enabled: false, used: { amount_minor: 15421, exponent: 2, currency: "USD" }, limit: { amount_minor: 15000, exponent: 2 } },
  }, now);
  assert.deepEqual(parsed.windows.map((w) => [w.label, w.used]), [["5h", 0.5], ["week", 52], ["Fable", 74], ["Future model", 6]]);
  assert.equal(parsed.windows[0].reset, Date.parse("2026-09-23T14:00:00.488018+00:00"));
  assert.deepEqual(parsed.extra, { enabled: false, used: 154.21, limit: 150, currency: "USD" });
  assert.deepEqual(mod.parseClaudeQuota(null, now).windows, []);
  assert.deepEqual(mod.parseClaudeQuota({ five_hour: { utilization: -1 } }, now).windows, []);
});

test("Codex headers support case, windows, reset epochs and durations, and missing data", () => {
  const quota = mod.parseCodexHeaders({
    "X-Codex-Primary-Used-Percent": "12.5", "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-after-seconds": "600", "x-codex-secondary-used-percent": "0",
    "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": `${now / 1000 + 3600}`,
  }, now);
  assert.deepEqual(quota.windows, [{ label: "5h", used: 12.5, reset: now + 600_000 }, { label: "week", used: 0, reset: now + 3600_000 }]);
  assert.equal(mod.parseCodexHeaders({}, now), undefined);
  assert.equal(mod.parseCodexHeaders({ "x-codex-primary-used-percent": "" }, now), undefined);
  assert.equal(mod.parseCodexHeaders({ "x-codex-primary-used-percent": "NaN" }, now), undefined);
});

// Shape of ChatGPT's GET /backend-api/wham/usage (identity fields omitted).
const codexUsage = (used = 25, at = now) => ({
  plan_type: "prolite",
  rate_limit: { allowed: true, limit_reached: false, secondary_window: null,
    primary_window: { used_percent: used, limit_window_seconds: 604800, reset_after_seconds: 515799, reset_at: at / 1000 + 86400 } },
  additional_rate_limits: [{ limit_name: "gpt-reserve", metered_feature: "base_model_inference",
    rate_limit: { secondary_window: null, primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: at / 1000 + 7200 } } }],
  credits: { has_credits: false, balance: "0" },
});
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

test("Codex usage endpoint: plan windows and named pools, percent points, epoch resets", () => {
  const quota = mod.parseCodexUsage(codexUsage(), now);
  assert.equal(quota.source, "Codex acct");
  assert.deepEqual(quota.windows, [
    { label: "week", used: 25, reset: now + 86400_000 },
    { label: "gpt-reserve", used: 0, reset: now + 7200_000 },
  ]);
  const both = mod.parseCodexUsage({ rate_limit: {
    primary_window: { used_percent: 0.5, limit_window_seconds: 18000, reset_after_seconds: 60 },
    secondary_window: { used_percent: 64, limit_window_seconds: 604800 } } }, now);
  assert.deepEqual(both.windows, [{ label: "5h", used: 0.5, reset: now + 60_000 }, { label: "week", used: 64, reset: undefined }]);
  assert.deepEqual(mod.parseCodexUsage(null, now).windows, []);
  assert.deepEqual(mod.parseCodexUsage({ rate_limit: { primary_window: { used_percent: "bad" } } }, now).windows, []);
  assert.equal(mod.codexWindowLabel(86400, "x"), "1d");
  assert.equal(mod.codexWindowLabel(undefined, "primary"), "primary");
});

test("Codex account id comes from Pi's token claim; header snapshots keep named pools", () => {
  assert.equal(mod.codexAccountId(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })), "acct-1");
  assert.equal(mod.codexAccountId(jwt({})), undefined);
  assert.equal(mod.codexAccountId("sk-not-a-jwt"), undefined);
  const base = mod.parseCodexUsage(codexUsage(), now - 60_000);
  const merged = mod.mergeQuota(base, mod.parseCodexHeaders({
    "x-codex-primary-used-percent": "30", "x-codex-primary-window-minutes": "10080" }, now));
  assert.deepEqual(merged.windows.map((w) => [w.label, w.used]), [["week", 30], ["gpt-reserve", 0]]);
  assert.equal(merged.updated, now);
});

test("Git parser distinguishes staged, unstaged, untracked, conflicts and rename paths", () => {
  const result = mod.parseGitStatus([
    "# branch.oid aabbccddeeff", "# branch.head feat/test", "# branch.ab +2 -3",
    "1 M. N... fields file", "1 .M N... fields file", "? untracked\nfile",
    "2 R. N... fields renamed", "? this-is-a-rename-source-not-an-untracked-file", "u UU N... fields conflict", "",
  ].join("\0"));
  assert.deepEqual(result, { branch: "feat/test", staged: 2, changed: 1, untracked: 1, conflicts: 1, ahead: 2, behind: 3, added: 0, removed: 0 });
  assert.equal(mod.parseGitStatus("# branch.oid aabbccddeeff\0# branch.head (detached)\0").branch, "detached:aabbccd");
  assert.equal(mod.parseGitStatus("# branch.oid (initial)\0# branch.head main\0").branch, "main");
});

test("real Git porcelain output parses, including an unborn repository", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-git-"));
  try {
    execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
    await writeFile(path.join(dir, "new.txt"), "hello");
    const result = mod.parseGitStatus(execFileSync("git", ["status", "--porcelain=v2", "--branch", "-z"], { cwd: dir, encoding: "utf8" }));
    assert.equal(result.branch, "main"); assert.equal(result.untracked, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("all widths 1..240 fit in both real Pi themes, including ANSI and wide Unicode", () => {
  for (const name of ["light", "dark"]) {
    const paint = getThemeByName(name);
    const s = fixture();
    s.git.project = "日本語のproject";
    s.git.branch = "feature/a-very-long-branch-name-that-must-shrink";
    s.statuses = [paint.fg("warning", "PLAN mode: review before writing"), "background: long-task-running", "診断: 問題なし"];
    for (let width = 1; width <= 240; width++) {
      const rows = mod.renderFooter(s, width, paint);
      for (const row of rows) {
        assert.ok(visibleWidth(row) <= width, `${name} width ${width}: ${plain(row)}`);
        assert.ok(!row.includes("\n"));
      }
    }
  }
});

test("narrow layout protects model, context and the most-used quota", () => {
  const s = fixture();
  s.quotas[0].windows[2].used = 99;
  const rows = mod.renderFooter(s, 40, theme);
  assert.match(rows[0], /opus-5\.5/);
  assert.match(rows[1], /Context 28%/);
  assert.match(rows[2], /Claude acct/);
  assert.match(rows[2], /Fable 99%/);
  assert.doesNotMatch(rows.join("\n"), /diff|compact/);
});

test("git status uses the shared [wt ]branch ✖N ● ↑N ↓N format", () => {
  const s = fixture();
  s.git = { ...s.git, branch: "feat/x", worktree: true, conflicts: 2, ahead: 1, behind: 3 };
  assert.match(plain(mod.renderFooter(s, 160, theme)[0]), /dotfiles · wt feat\/x ✖2 ● ↑1 ↓3/);
  s.git = { ...s.git, worktree: false, conflicts: 0, staged: 0, changed: 0, untracked: 0, ahead: 0, behind: 0 };
  assert.match(plain(mod.renderFooter(s, 160, theme)[0]), /dotfiles · feat\/x\s{2,}/);
});

test("wide layout uses explicit labels without reintroducing secondary metrics", () => {
  const rows = mod.renderFooter(fixture(), 160, theme);
  assert.match(rows[0], /dotfiles · main ● ↑2\s{2,}opus-5\.5 · reasoning xhigh/);
  assert.match(rows[1], /Context 28% used [━─]{8}/);
  assert.doesNotMatch(rows[1], /cost/);
  assert.doesNotMatch(rows.slice(0, 2).join("\n"), /cache|OAuth|diff|compact|56k\/200k/);
  assert.match(rows[2], /5h 32% used/);
  assert.doesNotMatch(rows[2], /extra off/);
});

test("medium layout retains the labeled context gauge without cost", () => {
  const row = mod.renderFooter(fixture(), 80, theme)[1];
  assert.match(row, /Context 28% used [━─]{8}/);
  assert.doesNotMatch(row, /cost/);
});

test("unknown context and quota do not become zero; stale/reset-due limits remain labeled", () => {
  const s = fixture();
  s.context = { tokens: null, percent: null, contextWindow: 200_000 };
  s.cacheHit = undefined;
  s.quotas[0].updated = now - 20 * 60_000;
  assert.match(mod.renderFooter(s, 120, theme)[1], /Context unknown/);
  assert.doesNotMatch(mod.renderFooter(s, 120, theme)[1], /Context 0%/);
  assert.match(mod.renderFooter(s, 60, theme)[2], /stale/);
  s.quotas[0].updated = now;
  s.quotas[0].windows[0].reset = now - 1;
  assert.match(mod.renderFooter(s, 160, theme)[2], /reset due/);
  s.quotas = []; s.unavailableQuota = "Codex acct";
  assert.match(mod.renderFooter(s, 80, theme)[2], /Codex acct · limits unavailable/);
});

test("extension statuses wrap without losing notices or ANSI, no duplicate task UI", () => {
  const s = fixture();
  s.statuses = ["\x1b[31mPLAN mode\x1b[0m", "background task FAILED", "stash saved", "long\nstatus\ttext"];
  const rows = mod.renderFooter(s, 30, theme);
  const text = rows.slice(2).map(plain).join(" ");
  for (const word of ["PLAN", "FAILED", "stash", "status"]) assert.ok(text.includes(word));
  assert.ok(rows.slice(2).join("").includes("\x1b[31m"));
});

test("companion extension statuses fold into their rows, and degrade when absent or reshaped", () => {
  const statuses = new Map([
    ["auto-effort", "effort: medium (auto)"], ["lean-context", "lean: \u221212k tok"], ["cache-guard", "cache 4:12"],
    ["anthropic-billing", "extra usage x3"], ["tool-gate", "gate: 2 auto \u00b7 0 pushed back \u00b7 1 asked"], ["plan", "plan: A working (/plan)"],
  ]);
  const absorbed = mod.absorbStatuses(statuses, { claudeRow: true });
  assert.deepEqual(absorbed, { autoEffort: true, lean: "\u221212k tok", cache: "4:12", extraBilled: 3,
    rest: ["plan: A working (/plan)", "gate: 2 auto \u00b7 0 pushed back \u00b7 1 asked"] });

  const s = { ...fixture(), thinking: "medium", statuses: absorbed.rest, autoEffort: true, lean: absorbed.lean, cache: absorbed.cache, extraBilled: 3 };
  const rows = mod.renderFooter(s, 200, theme).map(plain);
  assert.match(rows[0], /reasoning medium \(auto\)/);
  assert.match(rows[1], /lean \u221212k tok/);
  assert.match(rows[1], /cache 4:12/);
  for (const text of ["cache cold", "cache cold (model)", "cache cold?", "cache 1h05m"]) {
    assert.equal(mod.absorbStatuses(new Map([["cache-guard", text]]), { claudeRow: false }).cache, text.slice(6));
  }
  assert.deepEqual(mod.absorbStatuses(new Map([["cache-guard", "cache is weird"]]), { claudeRow: false }).rest, ["cache is weird"]);
  assert.match(rows.at(-1), /3 requests billed to extra usage/);
  assert.doesNotMatch(rows.join("\n"), /effort:|lean:|extra usage x3|cache-guard/);
  assert.match(rows[2], /plan: A working.* gate: /);
  // The model never drops for a companion's segment, and every row fits.
  for (let width = 1; width <= 160; width++) assert.ok(mod.renderFooter(s, width, theme).every((row) => visibleWidth(row) <= width));
  assert.match(plain(mod.renderFooter(s, 50, theme).at(-1)), /extra x3/);

  // The trend arrow and a limit note ride along inside the parentheses.
  for (const [text, shown] of [["effort: low (auto \u2192)", "auto \u2192"], ["effort: medium (auto \u2193, limited: 5h 84%)", "auto \u2193, limited: 5h 84%"]]) {
    const a = mod.absorbStatuses(new Map([["auto-effort", text]]), { claudeRow: false });
    assert.deepEqual(a.rest, []);
    const row = plain(mod.renderFooter({ ...fixture(), thinking: "low", statuses: a.rest, autoEffort: a.autoEffort, autoEffortDetail: a.autoEffortDetail }, 200, theme)[0]);
    assert.ok(row.includes(`reasoning low (${shown})`), row);
  }

  // Companions not installed (no statuses): the plain footer.
  const bare = mod.absorbStatuses(new Map(), { claudeRow: true });
  assert.deepEqual(bare, { autoEffort: false, rest: [] });
  const plainRows = mod.renderFooter({ ...fixture(), ...bare, statuses: bare.rest }, 200, theme).map(plain);
  assert.match(plainRows[0], /reasoning xhigh$/);
  assert.doesNotMatch(plainRows.join("\n"), /auto|lean|billed/);

  // No Claude limits row to attach to, or an unrecognized shape: keep the notice as-is.
  const fallback = mod.absorbStatuses(new Map([
    ["anthropic-billing", "extra usage x3"], ["auto-effort", "\x1b[33meffort: something new\x1b[0m"], ["lean-context", "trimmed"],
  ]), { claudeRow: false });
  assert.deepEqual(fallback, { autoEffort: false, rest: ["extra usage x3", "\x1b[33meffort: something new\x1b[0m", "trimmed"] });
});

test("a stashed prompt gets its own row under the editor, with a preview when readable", () => {
  const absorbed = mod.absorbStatuses(new Map([["prompt-stash", "\x1b[36mprompt stashed\x1b[0m"]]), { claudeRow: true });
  assert.deepEqual(absorbed, { autoEffort: false, stashed: true, rest: [] });
  const s = { ...fixture(), statuses: absorbed.rest, stash: { text: "refactor the quota poller\n\nso that it backs off\non 429" } };
  const rows = mod.renderFooter(s, 120, theme).map(plain);
  assert.equal(rows[0], '\u203a Stashed \u00b7 "refactor the quota poller" +2 lines \u00b7 ctrl+s to restore');
  assert.match(rows[1], /^dotfiles/);
  assert.doesNotMatch(rows.join("\n"), /prompt stashed/);
  // Narrow: the preview shrinks, then goes, then the hint shortens; the label stays.
  assert.match(plain(mod.renderFooter(s, 60, theme)[0]), /^\u203a Stashed \u00b7 "refactor the q[^"]*\u2026" \+2 lines \u00b7 ctrl\+s to restore$/);
  assert.equal(plain(mod.renderFooter(s, 20, theme)[0]), "\u203a Stashed \u00b7 ctrl+s");
  for (let width = 1; width <= 160; width++) assert.ok(mod.renderFooter(s, width, theme).every((row) => visibleWidth(row) <= width));
  // pi-stash's internals unreadable: still a row, just without the preview.
  assert.equal(plain(mod.renderFooter({ ...s, stash: {} }, 120, theme)[0]), "\u203a Stashed \u00b7 ctrl+s to restore");
  // Unrecognized text from the stash extension stays in the status row.
  assert.deepEqual(mod.absorbStatuses(new Map([["prompt-stash", "2 prompts stashed"]]), { claudeRow: true }).rest, ["2 prompts stashed"]);
});

test("pi-bg's tasks get their own row under the context row", () => {
  const absorbed = mod.absorbStatuses(new Map([["bg", "bg: tests 2:14 \u00b7 vite ready (kept) \u00b7 lint \u2717 \u00b7 fmt \u2713 \u00b7 +1"]]), { claudeRow: true });
  assert.deepEqual(absorbed.bg, [
    { kind: "job", name: "tests", elapsed: "2:14" },
    { kind: "service", name: "vite", state: "ready", kept: true },
    { kind: "ended", name: "lint", mark: "\u2717" },
    { kind: "ended", name: "fmt", mark: "\u2713" },
    { kind: "more", count: 1 },
  ]);
  assert.deepEqual(absorbed.rest, []);
  const s = { ...fixture(), statuses: absorbed.rest, bg: absorbed.bg };
  const rows = mod.renderFooter(s, 160, theme).map(plain);
  assert.equal(rows[2], "bg \u00b7 tests 2:14 \u00b7 vite ready kept \u00b7 lint \u2717 \u00b7 fmt \u2713 \u00b7 +1");
  // Narrow: what ended fine and the count go first; running and failed work stays.
  assert.equal(plain(mod.renderFooter(s, 34, theme)[2]), "bg \u00b7 tests 2:14 \u00b7 vite \u00b7 lint \u2717");
  // Another shape stays in the status row.
  assert.deepEqual(mod.absorbStatuses(new Map([["bg", "bg: something new happened"]]), { claudeRow: true }).rest, ["bg: something new happened"]);
});

test("pi-marimo's notebook gets its own row under the context row", () => {
  const absorbed = mod.absorbStatuses(new Map([
    ["marimo", "marimo: fit.py \u00b7 running Data loading \u203a Model fit (12s) \u00b7 2 queued \u00b7 1 error \u00b7 also prep.py, plots.py"],
  ]), { claudeRow: true });
  assert.deepEqual(absorbed.marimo, { notebook: "fit.py", running: { section: "Data loading \u203a Model fit", elapsed: "12s" }, queued: 2, errors: 1, others: ["prep.py", "plots.py"], notes: [] });
  assert.deepEqual(absorbed.rest, []);
  const s = { ...fixture(), statuses: absorbed.rest, marimo: absorbed.marimo };
  const rows = mod.renderFooter(s, 160, theme).map(plain);
  assert.match(rows[1], /^Context/);
  assert.equal(rows[2], "marimo fit.py \u00b7 running Data loading \u203a Model fit 12s \u00b7 2 queued \u00b7 1 error \u00b7 also prep.py, plots.py");
  // Narrower: queued goes first, then the other notebooks become a count, then the label goes and the
  // section shortens to its deepest heading; which notebook is current and how many others never go.
  assert.equal(plain(mod.renderFooter(s, 90, theme)[2]), "marimo fit.py \u00b7 running Data loading \u203a Model fit 12s \u00b7 1 error \u00b7 also prep.py, plots.py");
  assert.equal(plain(mod.renderFooter(s, 58, theme)[2]), "fit.py \u00b7 running Model fit 12s \u00b7 1 error \u00b7 +2 more");
  // An older pi-marimo sent only a count.
  assert.deepEqual(mod.absorbStatuses(new Map([["marimo", "marimo: fit.py \u00b7 +3 open"]]), { claudeRow: true }).marimo, { notebook: "fit.py", others: 3, notes: [] });

  const idle = mod.absorbStatuses(new Map([["marimo", "marimo: fit.py \u00b7 disconnected"]]), { claudeRow: true }).marimo;
  assert.deepEqual(idle, { notebook: "fit.py", notes: ["disconnected"] });
  // Another shape stays in the status row.
  assert.deepEqual(mod.absorbStatuses(new Map([["marimo", "notebook ready"]]), { claudeRow: true }).rest, ["notebook ready"]);
});

test("external text is sanitized and over-100 gauges are bounded", () => {
  const s = fixture();
  s.git.project = "project\x1b[2J\nattack";
  s.quotas[0].windows[0].used = 125;
  const text = mod.renderFooter(s, 160, theme).join("\n");
  assert.ok(!text.includes("\x1b[2J")); assert.match(text, /125%/);
  assert.equal(mod.shortModel("claude-sonnet-4-5-20250929"), "sonnet-4.5");
});

function host(entries = [], cwd = os.tmpdir(), mode = "tui") {
  const handlers = new Map(), commands = new Map(), statuses = new Map(), notices = [];
  let footer, editorFactory, disposed = 0, paints = 0, name = "";
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(key, command) { commands.set(key, command); },
    getThinkingLevel: () => "xhigh", getSessionName: () => name,
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  const ctx = {
    mode, cwd, model: { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 200000, reasoning: true },
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    modelRegistry: { isUsingOAuth: () => true,
      getApiKeyForProvider: async (p) => p === "openai-codex" ? jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }) : undefined },
    isIdle: () => true, hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 200000 }),
    ui: {
      setStatus(key, value) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setFooter(factory) {
        footer?.dispose();
        footer = factory?.({ requestRender() { paints++; } }, theme, {
          getGitBranch: () => null, getExtensionStatuses: () => statuses,
          onBranchChange: () => () => { disposed++; },
        });
      },
      notify(text) { notices.push(text); },
      theme,
      getEditorComponent: () => editorFactory,
      setEditorComponent(factory) { editorFactory = factory; },
    },
  };
  mod.default(pi);
  return { handlers, commands, ctx, entries, statuses, notices, pi,
    get editorFactory() { return editorFactory; }, set editorFactory(f) { editorFactory = f; },
    get footer() { return footer; }, get disposed() { return disposed; }, get paints() { return paints; },
  };
}

test("factory is inert in non-TUI modes and does not replace the editor", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const h = host([], os.tmpdir(), mode);
    await h.handlers.get("session_start")({}, h.ctx);
    assert.equal(h.footer, undefined);
    await h.handlers.get("turn_start")({}, h.ctx);
    await h.handlers.get("session_shutdown")({}, h.ctx);
  }
});

test("lifecycle: native fallback, mode persistence, provider isolation, reload and cleanup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-lifecycle-"));
  const oldHome = process.env.HOME;
  const oldTmux = process.env.TMUX;
  const oldHerdr = process.env.HERDR_ENV;
  process.env.HOME = dir; delete process.env.TMUX; delete process.env.HERDR_ENV;
  const timers = new Set();
  const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (callback) => { const timer = { callback, unref() {} }; timers.add(timer); return timer; };
  globalThis.clearInterval = (timer) => { timers.delete(timer); };
  // No network: the usage endpoint is stubbed and each request is recorded.
  const realFetch = globalThis.fetch, fetches = [];
  const usedPercent = 25;
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, headers: init.headers });
    return { ok: true, json: async () => codexUsage(usedPercent, Date.now() + 30_000) };
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  let h;
  try {
    h = host([], dir);
    h.statuses.set("plan", "PLAN mode");
    await h.handlers.get("session_start")({}, h.ctx);
    assert.equal(timers.size, 1);
    for (const variant of ["", "\ufe0e", "\ufe0f"]) {
      const status = `\x1b[36m\u{1f50c}${variant} MCP: 5 connected\x1b[39m`;
      h.statuses.set("mcp", status);
      const rendered = h.footer.render(120).join("\n");
      assert.ok(rendered.includes("\x1b[36m\uf1e6 MCP: 5 connected\x1b[39m"), "MCP uses a flat plug and preserves color/text");
      assert.doesNotMatch(rendered, /\u{1f50c}/u);
      assert.equal(h.statuses.get("mcp"), status, "presentation does not mutate the extension status");
      for (let width = 1; width <= 240; width++) {
        assert.ok(h.footer.render(width).every((row) => visibleWidth(row) <= width));
      }
    }
    assert.match(h.footer.render(120).join("\n"), /PLAN mode/);
    assert.doesNotMatch(plain(h.footer.render(120)[0]), /\(auto\)/);
    h.statuses.set("auto-effort", "effort: xhigh (auto)");
    assert.match(plain(h.footer.render(120)[0]), /reasoning xhigh \(auto\)/);
    assert.doesNotMatch(h.footer.render(120).join("\n"), /effort:/);
    h.statuses.delete("auto-effort");
    assert.doesNotMatch(plain(h.footer.render(120)[0]), /\(auto\)/);
    await settle();
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(fetches[0].headers["chatgpt-account-id"], "acct-1");
    assert.match(h.footer.render(120).join("\n"), /Codex acct · week 25% used \(resets in 1d0h\) · gpt-reserve 0% used/);
    assert.doesNotMatch(h.footer.render(120).join("\n"), /Claude acct/);
    await h.handlers.get("after_provider_response")({ headers: {
      "x-codex-primary-used-percent": "45", "x-codex-primary-window-minutes": "10080" } }, h.ctx);
    assert.match(h.footer.render(120).join("\n"), /Codex acct · week 45% used.*gpt-reserve 0%/);
    for (const timer of timers) timer.callback();
    await settle();
    assert.equal(fetches.length, 1, "usage endpoint is throttled");
    await h.handlers.get("model_select")({}, h.ctx);
    assert.match(h.footer.render(120).join("\n"), /week 45%/, "account limits survive a model switch");
    await h.commands.get("status").handler("all", h.ctx);
    assert.match(h.footer.render(120).join("\n"), /Claude acct · limits unavailable/);
    await h.commands.get("status").handler("native", h.ctx);
    assert.equal(h.footer, undefined);
    assert.ok(h.disposed >= 2);
    await h.handlers.get("session_shutdown")({}, h.ctx);
    assert.equal(timers.size, 0);
    await h.handlers.get("session_start")({}, h.ctx);
    assert.equal(h.footer, undefined, "native mode restored from session state");
    assert.equal(timers.size, 1);
    await h.commands.get("status").handler("on", h.ctx);
    assert.ok(h.footer);
    h.ctx.model = { provider: "radius", id: "balanced", reasoning: false };
    await h.handlers.get("model_select")({}, h.ctx);
    assert.doesNotMatch(h.footer.render(120).join("\n"), /Claude acct|Codex|45%/);
    await h.commands.get("status").handler("all", h.ctx);
    assert.match(h.footer.render(120).join("\n"), /Codex acct · week/, "/status all shows Codex on other providers");
    await h.commands.get("status").handler("on", h.ctx);
    h.entries.push({ type: "usage", usage: usage(4) });
    for (const timer of timers) timer.callback();
    assert.doesNotMatch(h.footer.render(120).join("\n"), /cost/);
    await h.commands.get("status").handler("details", h.ctx);
    const details = h.notices.at(-1);
    assert.match(details, /Context: unknown of 200k tokens; usage unknown/);
    assert.match(details, /Cache reuse: not measured/);
    assert.match(details, /Estimated session cost: \$4\.00/);
    assert.match(details, /Recorded tokens: 100 input, 20 output, 300 cache reads, 100 cache writes/);
    assert.match(details, /Tracked Git changes:/);
    await h.handlers.get("session_shutdown")({}, h.ctx);
    assert.equal(timers.size, 0); assert.equal(h.footer, undefined);
    const paints = h.paints;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.paints, paints, "late subprocess callbacks cannot repaint old UI");
  } finally {
    if (h) await h.handlers.get("session_shutdown")({}, h.ctx);
    globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval;
    globalThis.fetch = realFetch;
    for (const [key, value] of [["HOME", oldHome], ["TMUX", oldTmux], ["HERDR_ENV", oldHerdr]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi's actual extension loader accepts the source and registers only a command/events", async () => {
  const { loadExtensions } = await import(pathToFileURL(path.join(root, "dist/core/extensions/loader.js")));
  const loaded = await loadExtensions([entry], os.tmpdir());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].commands.has("status"));
  assert.equal(loaded.extensions[0].tools.size, 0);
});

if (process.env.STATUS_PREVIEW === "1") {
  for (const width of [40, 60, 80, 120, 160]) {
    console.log(`\n--- ${width} columns ---\n${mod.renderFooter(fixture(), width, getThemeByName("light")).join("\n")}`);
  }
}

test("lifts accent halfway toward body text, keeping its hue, and leaves other tokens alone", () => {
  const seen = [];
  const styled = {
    colors: { accent: { kind: "rgb", r: 177, g: 147, b: 186 }, text: { kind: "rgb", r: 197, g: 200, b: 198 } },
    style: (text, { fg }) => { seen.push(fg); return `<${text}>`; },
    fg: (color, text) => `${color}:${text}`, bold: (text) => `*${text}*`,
  };
  const paint = mod.liftAccent(styled);
  assert.equal(paint.fg("accent", "x"), "<x>");
  assert.equal(paint.fg("muted", "x"), "muted:x");
  assert.equal(paint.bold("x"), "*x*");
  const [fg] = seen;
  assert.equal(fg.kind, "oklch");
  assert.ok(fg.l > 0.72 && fg.l < 0.83, `lightness ${fg.l} between accent and text`);
  assert.ok(Math.abs(fg.h - 316) < 5, `hue ${fg.h} kept`);
  // Themes without concrete colors (older pi, or indexed colors) keep their own accent.
  assert.equal(mod.liftAccent(theme), theme);
  assert.equal(mod.liftAccent({ ...styled, colors: { accent: { kind: "indexed", index: 5 }, text: styled.colors.text } }).fg("accent", "x"), "accent:x");
});

test("the editor borders carry the context gauge, keeping the editor's border color and scroll label", () => {
  const border = (text) => `<${text}>`;
  const row = mod.gaugeBorder(20, 25, { fg: (color, text) => `[${color}:${text}]`, bold: (t) => t }, border);
  assert.equal(row, `[accent:${"━".repeat(5)}]<${"─".repeat(15)}>`);
  const hot = plain(mod.gaugeBorder(20, 95, theme, (t) => t));
  assert.equal(hot, "━".repeat(19) + "─");
  const labeled = mod.gaugeBorder(30, 50, theme, (t) => t, " ↑ 3 more ");
  assert.equal(visibleWidth(labeled), 30);
  assert.match(labeled, /^━{10} ↑ 3 more ─{10}$/);
  assert.equal(visibleWidth(mod.gaugeBorder(8, 50, theme, (t) => t, " ↑ 3 more ")), 8);
  assert.equal(mod.gaugeBorder(10, 250, theme, (t) => t), "━".repeat(10));
});

test("border hooks fall back to the editor's own until a percentage is known", () => {
  class Editor {
    borderColor = (t) => t;
    renderTopBorder(width, hidden) { return `top${width}${hidden}`; }
    renderBottomBorder(width, hidden) { return `bottom${width}${hidden}`; }
  }
  const editor = new Editor();
  let used = null;
  assert.equal(mod.drawGaugeOnBorders(editor, () => used, () => theme), true);
  assert.equal(editor.renderTopBorder(10, 0), "top100");
  used = 50;
  assert.equal(editor.renderTopBorder(10, 0), "━━━━━─────");
  assert.match(editor.renderBottomBorder(20, 2), /↓ 2 more/);
  // Wrapping again (a new session) replaces the hooks instead of stacking them.
  mod.drawGaugeOnBorders(editor, () => null, () => theme);
  assert.equal(editor.renderBottomBorder(10, 1), "bottom101");
  assert.equal(mod.drawGaugeOnBorders({}, () => 50, () => theme), false);
});

test("the context row drops its own gauge when the editor borders draw it", () => {
  const row = mod.renderFooter({ ...fixture(), borderGauge: true }, 160, theme)[1];
  assert.match(row, /Context 28% used/);
  assert.doesNotMatch(row, /[━─]/);
});

test("wraps the installed editor once per session instead of replacing it", async () => {
  const h = host();
  class Editor {
    borderColor = (t) => t;
    renderTopBorder() { return "vim-top"; }
    renderBottomBorder() { return "vim-bottom"; }
  }
  let built = 0;
  h.editorFactory = () => { built++; return new Editor(); };
  try {
    await h.handlers.get("session_start")({}, h.ctx);
    await h.handlers.get("session_start")({}, h.ctx);
    const editor = h.editorFactory();
    assert.equal(built, 1);
    assert.ok(editor instanceof Editor);
    assert.equal(editor.renderTopBorder(10, 0), "vim-top"); // context unknown
    h.ctx.getContextUsage = () => ({ tokens: 100000, percent: 50, contextWindow: 200000 });
    assert.equal(plain(editor.renderTopBorder(10, 0)), "━━━━━─────");
  } finally { await h.handlers.get("session_shutdown")?.({}, h.ctx); }
});
