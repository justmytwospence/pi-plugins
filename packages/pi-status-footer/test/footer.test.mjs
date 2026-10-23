import assert from "node:assert/strict";
import { ChildProcess, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters as plain } from "node:util";
import { test, vi } from "vitest";

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
  cacheHit: 94, git: { branch: "main", upstream: "origin/main", project: "dotfiles", staged: 0, unstaged: 2, changed: 3, untracked: 1, conflicts: 0, ahead: 2, behind: 0, added: 25, removed: 4 },
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

test("Claude limit headers are fractions with epoch-second resets, and update cached windows", () => {
  const quota = mod.parseClaudeHeaders({
    "Anthropic-Ratelimit-Unified-5h-Utilization": "0.125", "anthropic-ratelimit-unified-5h-reset": `${now / 1000 + 600}`,
    "anthropic-ratelimit-unified-7d-utilization": "0.94", "anthropic-ratelimit-unified-status": "allowed",
  }, now);
  assert.equal(quota.source, "Claude acct");
  assert.deepEqual(quota.windows, [{ label: "5h", used: 12.5, reset: now + 600_000 }, { label: "week", used: 94, reset: undefined }]);
  assert.equal(mod.parseClaudeHeaders({}, now), undefined);
  assert.equal(mod.parseClaudeHeaders({ "anthropic-ratelimit-unified-5h-utilization": "" }, now), undefined);
  assert.equal(mod.parseClaudeHeaders({ "anthropic-ratelimit-unified-5h-utilization": "-1" }, now), undefined);
  const cached = mod.parseClaudeQuota({ five_hour: { utilization: 80 }, limits: [
    { kind: "weekly_scoped", percent: 74, scope: { model: { display_name: "Fable" } } }] }, now - 60_000);
  const merged = mod.mergeQuota(cached, quota);
  assert.deepEqual(merged.windows.map((w) => [w.label, w.used]), [["5h", 12.5], ["Fable", 74], ["week", 94]]);
  assert.equal(merged.updated, now);
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

test("Codex's streamed rate-limit event reads like the usage endpoint", () => {
  // Shape observed on Pi's WebSocket transport (credits/promo trimmed).
  const event = { type: "codex.rate_limits", plan_type: "prolite", rate_limits: { allowed: true, limit_reached: false,
    primary: { used_percent: 46, window_minutes: 10080, reset_after_seconds: 476905, reset_at: now / 1000 + 86400 }, secondary: null },
    additional_rate_limits: null };
  const quota = mod.parseCodexUsage(mod.codexRateLimitsEvent(event), now);
  assert.deepEqual(quota.windows, [{ label: "week", used: 46, reset: now + 86400_000 }]);
  const pools = mod.parseCodexUsage(mod.codexRateLimitsEvent({ ...event, additional_rate_limits: [{ limit_name: "gpt-reserve",
    rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 604800 } } }] }), now);
  assert.deepEqual(pools.windows.map((w) => [w.label, w.used]), [["week", 46], ["gpt-reserve", 3]]);
  assert.equal(mod.codexRateLimitsEvent({ type: "response.created" }), undefined);
  assert.deepEqual(mod.parseCodexUsage(mod.codexRateLimitsEvent({ type: "codex.rate_limits" }), now).windows, []);
});

test("Git parser distinguishes staged, unstaged, untracked, conflicts and rename paths", () => {
  const result = mod.parseGitStatus([
    "# branch.oid aabbccddeeff", "# branch.head feat/test", "# branch.upstream origin/feat/test", "# branch.ab +2 -3",
    "1 MM N... 100644 100644 100644 aabbccd aabbccd file", "? untracked\nfile",
    "2 R. N... 100644 100644 100644 aabbccd aabbccd R100 renamed", "? this-is-a-rename-source-not-an-untracked-file",
    "u UU N... 100644 100644 100644 100644 aabbccd aabbccd aabbccd conflict", "",
  ].join("\0"));
  assert.deepEqual(result, { branch: "feat/test", upstream: "origin/feat/test", staged: 2, unstaged: 1, changed: 4, untracked: 1, conflicts: 1, ahead: 2, behind: 3, added: 0, removed: 0 });
  assert.equal(mod.parseGitStatus("# branch.oid aabbccddeeff\0# branch.head (detached)\0").branch, "detached:aabbccd");
  assert.equal(mod.parseGitStatus("# branch.oid (initial)\0# branch.head main\0").branch, "main");
});

test("real Git porcelain output parses, including an unborn repository", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-git-"));
  try {
    execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
    await writeFile(path.join(dir, "new.txt"), "hello");
    const result = mod.parseGitStatus(execFileSync("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"], { cwd: dir, encoding: "utf8" }));
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
  assert.match(rows[1], /opus-5\.5/);
  assert.match(rows[2], /Context\s+28%/);
  assert.match(rows[3], /Claude/);
  assert.match(rows[3], /Fable 99%/);
  assert.doesNotMatch(rows.join("\n"), /diff|compact/);
});

test("git status uses minimal suffix and hides zero terms", () => {
  const s = fixture();
  s.git = { ...s.git, branch: "feat/x", worktree: true, changed: 5, conflicts: 2, ahead: 1, behind: 3 };
  assert.match(plain(mod.renderFooter(s, 160, theme)[0]), /dotfiles · \ue725 feat\/x \* ↑1 ↓3 !/);
  s.git = { ...s.git, worktree: false, conflicts: 0, staged: 0, unstaged: 0, changed: 0, untracked: 0, ahead: 0, behind: 0 };
  assert.match(plain(mod.renderFooter(s, 160, theme)[0]), /dotfiles · \ue725 feat\/x$/);
  s.git.upstream = undefined;
  assert.match(mod.renderFooter(s, 160, theme)[0], /feat\/x$/);
  s.git.changed = 2; s.git.conflicts = 1;
  assert.match(mod.renderFooter(s, 160, theme)[0], /feat\/x \* !/);
  s.git.unavailable = true;
  assert.match(mod.renderFooter(s, 160, theme)[0], /!/);
  assert.doesNotMatch(mod.renderFooter(s, 160, theme)[0], /no upstream|changed|conflict|wt /);
});

test("minimal Git suffix covers each dirty dimension, quiet tracking and unreadable identity", () => {
  const s = fixture();
  const clean = { ...s.git, changed: 0, staged: 0, unstaged: 0, untracked: 0,
    conflicts: 0, ahead: 0, behind: 0 };
  const cases = [
    [{}, "main"], [{ worktree: true }, "main"],
    [{ upstream: undefined }, "main"], [{ upstreamMissing: true }, "main"],
    [{ staged: 1 }, "main *"], [{ unstaged: 1 }, "main *"],
    [{ untracked: 1 }, "main *"], [{ changed: 1 }, "main *"],
    [{ conflicts: 1 }, "main * !"],
    [{ conflicts: 2, ahead: 2, behind: 3 }, "main * ↑2 ↓3 !"],
    [{ ahead: 2 }, "main ↑2"], [{ behind: 3 }, "main ↓3"],
    [{ operation: true }, "main !"],
    [{ operation: true, conflicts: 1, ahead: 2, behind: 1 }, "main * ↑2 ↓1 !"],
    [{ operation: true, unavailable: true }, "main !"],
    [{ unavailable: true }, "main !"],
    [{ branch: undefined, unavailable: true }, "!"],
    [{ branch: "detached:aabbccd", untracked: 1 }, "detached:aabbccd *"],
  ];
  for (const [state, expected] of cases) {
    s.git = { ...clean, ...state };
    const row = plain(mod.renderFooter(s, 160, theme)[0]);
    assert.ok(row.includes(`dotfiles · ${s.git.branch ? "\ue725 " : ""}${expected}`), row);
    assert.doesNotMatch(row, /changed|conflicts|staged|untracked|upstream|wt /);
    for (const width of [20, 40, 80, 160]) {
      const rows = mod.renderFooter(s, width, theme);
      assert.equal(rows.length, mod.renderFooter(s, 160, theme).length);
      assert.ok(rows.every((line) => visibleWidth(line) <= width));
    }
  }
});

test("wide layout uses explicit labels without reintroducing secondary metrics", () => {
  const rows = mod.renderFooter(fixture(), 160, theme);
  assert.match(rows[0], /^ \uf07b dotfiles · \ue725 main \* ↑2$/);
  assert.match(rows[1], /^ \u{f06a9} opus-5\.5 · \uee9c reasoning xhigh$/u);
  assert.match(rows[2], /Context\s+28% used [━─]{8}/);
  assert.doesNotMatch(rows[2], /cost/);
  assert.doesNotMatch(rows.slice(0, 3).join("\n"), /cache|OAuth|diff|compact|56k\/200k/);
  assert.match(rows[3], /5h 32% used/);
  assert.doesNotMatch(rows[3], /extra off/);
});

test("footer uses natural spacing and a consistent inset without label columns", () => {
  const s = fixture();
  s.borderGauge = true;
  s.quotas = [
    { source: "Claude acct", updated: now, windows: [{ label: "5h", used: 32 }] },
    { source: "Codex acct", updated: now, windows: [{ label: "week", used: 41 }] },
  ];
  s.statuses = ["PLAN mode"];
  const rows = mod.renderFooter(s, 160, theme);
  assert.equal(rows[0], " \uf07b dotfiles · \ue725 main * ↑2");
  assert.equal(rows[1], " \u{f06a9} opus-5.5 · \uee9c reasoning xhigh");
  assert.equal(rows[2], " \uf0e4 Context 28% used");
  assert.equal(rows[3], " \uf0f3 PLAN mode");
  assert.equal(rows[4], " \uf252 Claude 5h 32% used");
  assert.equal(rows[5], " \uf252 Codex week 41% used");
  assert.ok(rows.every((row) => !/ {2}/.test(row)));
  assert.ok(rows.every((row) => row.startsWith(" ") && !row.endsWith(" ")));
  // Padding is cosmetic, never a reason to lose context on small terminals.
  assert.match(mod.renderFooter(s, 20, theme)[2], /^\uf0e4 Context 28% used$/);
});

test("footer lines share separators, concise labels and unparenthesized qualifiers", () => {
  const s = fixture();
  s.borderGauge = true;
  s.autoEffort = true;
  s.autoEffortDetail = "→";
  s.statuses = mod.absorbStatuses(new Map([["tool-gate", "gate: 0 auto · 0 pushed back · 0 asked"]]), { claudeRow: false }).rest;
  s.quotas = [{ source: "Codex acct", updated: now, windows: [{ label: "week", used: 39, reset: now + 86400_000 }] }];
  const rows = mod.renderFooter(s, 160, theme);
  assert.equal(rows[1], " \u{f06a9} opus-5.5 · \uee9c reasoning xhigh · auto →");
  assert.equal(rows[2], " \uf0e4 Context 28% used");
  assert.equal(rows[3], " \uf510 Gate 0 auto · 0 pushed back · 0 asked");
  assert.equal(rows[4], " \uf252 Codex week 39% used · resets in 1d0h");
  assert.deepEqual(mod.absorbStatuses(new Map([["tool-gate", "gate: off"]]), { claudeRow: false }).rest, ["Gate off"]);
  assert.deepEqual(mod.absorbStatuses(new Map([["tool-gate", "gate: new format"]]), { claudeRow: false }).rest, ["gate: new format"]);
});

test("dashboard hierarchy accents sections and quiets countdowns, not alerts", () => {
  const calls = [];
  const paint = { fg: (color, value) => { calls.push([color, value]); return value; }, bold: (value) => value };
  const s = fixture();
  s.quotas[0].windows[0].used = 95;
  s.cache = "cold";
  mod.renderFooter(s, 160, paint);
  for (const pair of [["muted", "Context"], ["muted", "Claude"], ["muted", "main"], ["muted", "5h"],
    ["dim", " used"], ["dim", "resets in 2h14m"], ["error", "95%"], ["warning", "❄"]]) {
    assert.ok(calls.some(([color, value]) => color === pair[0] && value === pair[1]), pair.join(": "));
  }
});

test("semantic colors distinguish thinking, healthy readings, cache and service states", () => {
  const calls = [];
  const paint = { fg: (color, value) => { calls.push([color, value]); return value; }, bold: (value) => value };
  const s = fixture();
  s.cache = "4:12";
  s.bg = [
    { kind: "service", name: "vite", state: "ready", kept: false },
    { kind: "service", name: "api", state: "starting", kept: false },
  ];
  mod.renderFooter(s, 160, paint);
  for (const [color, value] of [["thinkingXhigh", "xhigh"], ["muted", "28%"],
    ["muted", "32%"], ["success", "4:12"], ["success", "ready"], ["warning", "starting"]]) {
    assert.ok(calls.some(([c, v]) => c === color && v === value), `${color}: ${value}`);
  }
  for (const [level, color] of [["off", "thinkingOff"], ["minimal", "thinkingMinimal"],
    ["low", "thinkingLow"], ["medium", "thinkingMedium"], ["high", "thinkingHigh"],
    ["max", "thinkingMax"], ["future", "muted"]]) {
    calls.length = 0;
    s.thinking = level;
    mod.renderFooter(s, 160, paint);
    assert.ok(calls.some(([c, v]) => c === color && v === level));
  }
});

test("quota rows stay text-only at every width and mute stale readings", () => {
  const s = fixture();
  s.borderGauge = true;
  s.quotas[0].windows = [{ label: "5h", used: 75 }];
  assert.match(mod.renderFooter(s, 120, theme)[3], /75% used/);
  assert.doesNotMatch(mod.renderFooter(s, 120, theme)[3], /[━─]/);
  assert.doesNotMatch(mod.renderFooter(s, 80, theme)[3], /[━─]/);
  s.quotas[0].updated = now - 11 * 60_000;
  const calls = [];
  const paint = { fg: (c, v) => { calls.push([c, v]); return v; }, bold: (v) => v };
  assert.doesNotMatch(mod.renderFooter(s, 120, paint)[3], /[━─]/);
  assert.ok(calls.some(([c, v]) => c === "muted" && v === "75%"));
});

test("natural labels preserve wide characters and fit long names", () => {
  const s = fixture();
  s.quotas[0].source = "日本語 acct";
  const rows = mod.renderFooter(s, 160, theme);
  assert.match(rows[3], /^ \uf252 日本語 acct 5h/);
  s.quotas[0].source = "a very long account label that must shrink";
  s.statuses = ["診断: 問題なし ".repeat(20)];
  for (let width = 1; width <= 240; width++) {
    assert.ok(mod.renderFooter(s, width, theme).every((row) => visibleWidth(row) <= width));
  }
});

test("medium layout retains the labeled context gauge without cost", () => {
  const row = mod.renderFooter(fixture(), 80, theme)[2];
  assert.match(row, /Context\s+28% used [━─]{8}/);
  assert.doesNotMatch(row, /cost/);
});

test("unknown context and quota do not become zero; stale/reset-due limits remain labeled", () => {
  const s = fixture();
  s.context = { tokens: null, percent: null, contextWindow: 200_000 };
  s.cacheHit = undefined;
  s.quotas[0].updated = now - 20 * 60_000;
  assert.match(mod.renderFooter(s, 120, theme)[2], /Context\s+unknown/);
  assert.doesNotMatch(mod.renderFooter(s, 120, theme)[2], /Context\s+0%/);
  assert.match(mod.renderFooter(s, 60, theme)[3], /stale/);
  s.quotas[0].updated = now;
  s.quotas[0].windows[0].reset = now - 1;
  assert.match(mod.renderFooter(s, 160, theme)[3], /reset due/);
  assert.equal((mod.renderFooter(s, 160, theme)[3].match(/reset due/g) ?? []).length, 1);
  assert.match(mod.renderFooter(s, 40, theme)[3], /reset due/);
  s.quotas = []; s.unavailableQuota = "Codex acct";
  assert.match(mod.renderFooter(s, 80, theme)[3], /Codex\s+limits unavailable/);
});

test("extension statuses wrap without losing notices or ANSI, no duplicate task UI", () => {
  const s = fixture();
  s.statuses = ["\x1b[31mPLAN mode\x1b[0m", "background task FAILED", "stash saved", "long\nstatus\ttext"];
  const rows = mod.renderFooter(s, 30, theme);
  const text = rows.slice(3).map(plain).join(" ");
  for (const word of ["PLAN", "FAILED", "stash", "status"]) assert.ok(text.includes(word));
  assert.ok(rows.slice(3).join("").includes("\x1b[31m"));
});

test("companion extension statuses fold into their rows, and degrade when absent or reshaped", () => {
  const statuses = new Map([
    ["auto-effort", "effort: medium (auto)"], ["lean-context", "lean: \u221212k tok"], ["cache-guard", "cache 4:12"],
    ["anthropic-billing", "extra usage x3"], ["tool-gate", "gate: 2 auto \u00b7 0 pushed back \u00b7 1 asked"], ["plan", "plan: A working (/plan)"],
  ]);
  const absorbed = mod.absorbStatuses(statuses, { claudeRow: true });
  assert.deepEqual(absorbed, { autoEffort: true, lean: "\u221212k tok", cache: "4:12", extraBilled: 3,
    rest: ["Plan A working · /plan", "Gate 2 auto \u00b7 0 pushed back \u00b7 1 asked"] });

  const s = { ...fixture(), thinking: "medium", statuses: absorbed.rest, autoEffort: true, lean: absorbed.lean, cache: absorbed.cache, extraBilled: 3 };
  const rows = mod.renderFooter(s, 200, theme).map(plain);
  assert.match(rows[1], /reasoning medium · auto/);
  assert.match(rows[2], /Lean \u221212k tok/);
  assert.match(rows[2], /Cache 4:12/);
  for (const text of ["cache cold", "cache cold (model)", "cache cold?", "cache 1h05m"]) {
    assert.equal(mod.absorbStatuses(new Map([["cache-guard", text]]), { claudeRow: false }).cache, text.slice(6));
  }
  assert.deepEqual(mod.absorbStatuses(new Map([["cache-guard", "cache is weird"]]), { claudeRow: false }).rest, ["cache is weird"]);
  assert.match(rows.at(-1), /3 requests billed to extra usage/);
  assert.doesNotMatch(rows.join("\n"), /effort:|lean:|extra usage x3|cache-guard/);
  assert.match(rows[3], /^ \uf0f3 Plan A working.* \uf510 Gate /);
  // The model never drops for a companion's segment, and every row fits.
  for (let width = 1; width <= 160; width++) assert.ok(mod.renderFooter(s, width, theme).every((row) => visibleWidth(row) <= width));
  assert.match(plain(mod.renderFooter(s, 50, theme).at(-1)), /extra x3/);

  // The trend arrow and limit note follow the same dot separator.
  for (const [text, shown] of [["effort: low (auto \u2192)", "auto \u2192"], ["effort: medium (auto \u2193, limited: 5h 84%)", "auto \u2193, limited: 5h 84%"]]) {
    const a = mod.absorbStatuses(new Map([["auto-effort", text]]), { claudeRow: false });
    assert.deepEqual(a.rest, []);
    const row = plain(mod.renderFooter({ ...fixture(), thinking: "low", statuses: a.rest, autoEffort: a.autoEffort, autoEffortDetail: a.autoEffortDetail }, 200, theme)[1]);
    assert.ok(row.includes(`reasoning low · ${shown}`), row);
  }

  // Companions not installed (no statuses): the plain footer.
  const bare = mod.absorbStatuses(new Map(), { claudeRow: true });
  assert.deepEqual(bare, { autoEffort: false, rest: [] });
  const plainRows = mod.renderFooter({ ...fixture(), ...bare, statuses: bare.rest }, 200, theme).map(plain);
  assert.match(plainRows[1], /reasoning xhigh$/);
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
  assert.equal(rows[0], ' \uf187 Stashed \u00b7 "refactor the quota poller" +2 lines \u00b7 ctrl+s to restore');
  assert.match(rows[1], /^ \uf07b dotfiles/);
  assert.doesNotMatch(rows.join("\n"), /prompt stashed/);
  // Narrow: the preview shrinks, then goes, then the hint shortens; the label stays.
  assert.match(plain(mod.renderFooter(s, 60, theme)[0]), /^ \uf187 Stashed \u00b7 "refactor the [^"]*\u2026" \+2 lines \u00b7 ctrl\+s to restore$/);
  assert.equal(plain(mod.renderFooter(s, 20, theme)[0]), "\uf187 Stashed \u00b7 ctrl+s");
  for (let width = 1; width <= 160; width++) assert.ok(mod.renderFooter(s, width, theme).every((row) => visibleWidth(row) <= width));
  // pi-stash's internals unreadable: still a row, just without the preview.
  assert.equal(plain(mod.renderFooter({ ...s, stash: {} }, 120, theme)[0]), " \uf187 Stashed \u00b7 ctrl+s to restore");
  // Unrecognized text from the stash extension stays in the status row.
  assert.deepEqual(mod.absorbStatuses(new Map([["prompt-stash", "2 prompts stashed"]]), { claudeRow: true }).rest, ["2 prompts stashed"]);
});

test("optional companions share label style and preserve meaningful qualifiers", () => {
  const absorbed = mod.absorbStatuses(new Map([
    ["plan", "plan: A working · B cut off (resume in /plan) (/plan)"],
    ["tool-gate", "gate: off"],
    ["marimo", "marimo: fit.py · disconnected"],
    ["bg", "bg: vite starting (kept) · lint ✗ · fmt ■"],
  ]), { claudeRow: false });
  assert.deepEqual(absorbed.rest, ["Plan A working · B cut off · resume in /plan · /plan", "Gate off"]);
  const s = { ...fixture(), borderGauge: true, ...absorbed, statuses: absorbed.rest, cache: "cold (model)" };
  const rows = mod.renderFooter(s, 200, theme);
  assert.equal(rows[2], " \uf0e4 Context 28% used · Cache ❄ · model changed");
  assert.equal(rows[3], " \uf02d Marimo fit.py · disconnected");
  assert.equal(rows[4], " \uf085 Background vite starting kept · lint ✗ · fmt ■");
  assert.match(rows[5], /^ \uf0f3 Plan /);
  assert.match(mod.renderFooter({ ...s, cache: "cold?" }, 200, theme)[2], /Cache ❄ · unconfirmed/);
  assert.deepEqual(mod.absorbStatuses(new Map([["plan", "plan: new format"]]), { claudeRow: false }).rest, ["plan: new format"]);
  assert.deepEqual(mod.absorbStatuses(new Map([["third-party", "widget: Mixed CASE (keep me)"]]), { claudeRow: false }).rest, ["widget: Mixed CASE (keep me)"]);
});

test("all optional footer rows fit both themes at every width, alone and combined", () => {
  const companions = mod.absorbStatuses(new Map([
    ["auto-effort", "effort: high (auto ↑, limited: 5h 84%)"],
    ["lean-context", "lean: −12k tok"], ["cache-guard", "cache cold (model)"],
    ["anthropic-billing", "extra usage x3"], ["prompt-stash", "prompt stashed"],
    ["marimo", "marimo: 診断.py · running Data › Model fit (12s) · 2 queued · 1 error · also prep.py, plots.py"],
    ["bg", "bg: tests 2:14 · vite starting (kept) · lint ✗ · fmt ✓ · stopped ■ · +2"],
    ["plan", "plan: A asking you · B failed (/plan)"],
    ["tool-gate", "gate: 2 auto · 1 pushed back · 1 asked"],
    ["mcp", "\x1b[36m🔌 MCP: 5 connected\x1b[39m"],
    ["unknown", "診断: 問題なし (unchanged)"],
  ]), { claudeRow: true });
  const combined = { ...fixture(), ...companions, statuses: companions.rest, borderGauge: true,
    stash: { text: "review the optional components\nthen check terminal widths" },
    unavailableQuota: "Codex acct", phase: "error", queued: true, sessionName: "UI review",
  };
  combined.quotas[0].extra = { enabled: true, used: 12.5, limit: 50, currency: "USD" };
  combined.quotas[0].windows[0].reset = now - 1;
  const variants = [combined, ...["stash", "marimo", "bg", "cache", "lean", "autoEffort", "extraBilled"].map((key) => ({ ...fixture(), [key]: combined[key] })),
    { ...fixture(), stash: {} },
    ...["4:12", "1h05m", "cold", "cold?"].map((cache) => ({ ...fixture(), cache })),
    ...["marimo: idle.py", "marimo: local.py · :2718", "marimo: remote.py · nb.example.com/lab · disconnected", "marimo: queued.py · 2 queued", "marimo: broken.py · 2 errors · not open", "marimo: older.py · +3 open", "marimo: /marimo to pick one"].map((text) => ({ ...fixture(), marimo: mod.parseMarimoStatus(text) })),
    { ...fixture(), bg: mod.parseBgStatus("bg: api up · vite ready · lint ✗") },
    { ...fixture(), context: { percent: null, tokens: null, contextWindow: 200_000 }, quotas: [], unavailableQuota: "Claude acct" },
    { ...fixture(), quotas: [{ source: "Claude acct", updated: now, windows: [{ label: "named model pool", used: 99 }], extra: { enabled: true, used: 12.5, currency: "EUR" } }] },
  ];
  for (const name of ["light", "dark"]) {
    const paint = mod.liftAccent(getThemeByName(name));
    for (const s of variants) {
      for (let width = 1; width <= 240; width++) {
        const rows = mod.renderFooter(s, width, paint);
        assert.ok(rows.every((row) => visibleWidth(row) <= width), `${name}, width ${width}`);
        assert.ok(rows.every((row) => !/[\r\n\t]/.test(plain(row))));
      }
    }
    const text = mod.renderFooter(combined, 240, paint).map(plain).join("\n");
    for (const notice of ["Stashed", "Marimo", "Background", "lint ✗", "Plan", "Gate", "MCP", "reset due", "extra usage on", "3 requests billed", "limits unavailable"]) {
      assert.ok(text.includes(notice), notice);
    }
    assert.match(plain(mod.renderFooter(combined, 22, paint).find((row) => plain(row).startsWith("\uf085 Bg "))), /lint ✗/);
  }
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
  assert.equal(rows[3], " \uf085 Background tests 2:14 \u00b7 vite ready kept \u00b7 lint \u2717 \u00b7 fmt \u2713 \u00b7 +1");
  // Narrow: what ended fine and the count go first; running and failed work stays.
  assert.equal(plain(mod.renderFooter(s, 34, theme)[3]), "\uf085 Bg tests · vite ready · lint ✗");
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
  assert.match(rows[2], /^ \uf0e4 Context/);
  assert.equal(rows[3], " \uf02d Marimo fit.py \u00b7 running Data loading \u203a Model fit 12s \u00b7 2 queued \u00b7 1 error \u00b7 also prep.py, plots.py");
  // Narrower: queued goes first, then the other notebooks become a count, then the label goes and the
  // section shortens to its deepest heading; which notebook is current and how many others never go.
  assert.equal(plain(mod.renderFooter(s, 92, theme)[3]), " \uf02d Marimo fit.py \u00b7 running Data loading \u203a Model fit 12s \u00b7 1 error \u00b7 also prep.py, plots.py");
  assert.equal(plain(mod.renderFooter(s, 58, theme)[3]), "\uf02d fit.py \u00b7 running Model fit 12s \u00b7 1 error \u00b7 +2 more");
  // An older pi-marimo sent only a count.
  assert.deepEqual(mod.absorbStatuses(new Map([["marimo", "marimo: fit.py \u00b7 +3 open"]]), { claudeRow: true }).marimo, { notebook: "fit.py", others: 3, notes: [] });

  const idle = mod.absorbStatuses(new Map([["marimo", "marimo: fit.py \u00b7 disconnected"]]), { claudeRow: true }).marimo;
  assert.deepEqual(idle, { notebook: "fit.py", notes: ["disconnected"] });
  // Another shape stays in the status row.
  assert.deepEqual(mod.absorbStatuses(new Map([["marimo", "notebook ready"]]), { claudeRow: true }).rest, ["notebook ready"]);
});

test("pi-marimo's Lens selections get their own row under the marimo row", () => {
  const absorbed = mod.absorbStatuses(new Map([
    ["marimo", "marimo: fit.py"],
    ["marimo-lens", "lens: fit.py \u00b7 S1 \"make this blue\" \u00b7 S2 \u00b7 also prep.py 1"],
  ]), { claudeRow: true });
  assert.deepEqual(absorbed.lens, { notebook: "fit.py", selections: [{ label: "S1", note: "make this blue" }, { label: "S2", note: undefined }], others: ["prep.py 1"] });
  assert.deepEqual(absorbed.rest, []);
  const s = { ...fixture(), statuses: absorbed.rest, marimo: absorbed.marimo, lens: absorbed.lens };
  const rows = mod.renderFooter(s, 160, theme).map(plain);
  assert.match(rows[3], /Marimo fit\.py/);
  assert.equal(rows[4], " \uf06e Lens fit.py \u00b7 S1 make this blue \u00b7 S2 \u00b7 also prep.py 1");
  for (const width of [46, 120]) for (const row of mod.renderFooter(s, width, theme)) assert.ok(visibleWidth(row) <= width);
  // Another shape stays in the status row.
  assert.deepEqual(mod.absorbStatuses(new Map([["marimo-lens", "lens ready"]]), { claudeRow: true }).rest, ["lens ready"]);
});

test("external text is sanitized and over-100 gauges are bounded", () => {
  const s = fixture();
  s.git.project = "project\x1b[2J\nattack";
  s.quotas[0].windows[0].used = 125;
  const text = mod.renderFooter(s, 160, theme).join("\n");
  assert.ok(!text.includes("\x1b[2J")); assert.match(text, /125%/);
  assert.equal(mod.shortModel("claude-sonnet-4-5-20250929"), "sonnet-4.5");
});

function host(entries = [], cwd = os.tmpdir(), mode = "tui", nativeBranch = null) {
  const handlers = new Map(), commands = new Map(), statuses = new Map(), notices = [], workingMessages = [];
  const commandInfos = [], tools = [];
  let footer, editorFactory, disposed = 0, paints = 0, name = "", trusted = false;
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(key, command) { commands.set(key, command); },
    getThinkingLevel: () => "xhigh", getSessionName: () => name,
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    getCommands: () => commandInfos, getAllTools: () => tools,
  };
  const ctx = {
    mode, cwd, model: { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 200000, reasoning: true },
    sessionManager: { getEntries: () => entries, getBranch: () => entries },
    modelRegistry: { isUsingOAuth: () => true,
      getApiKeyForProvider: async (p) => p === "openai-codex" ? jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }) : undefined },
    isIdle: () => true, hasPendingMessages: () => false, isProjectTrusted: () => trusted,
    getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 200000 }),
    ui: {
      setWorkingMessage(message) { workingMessages.push(message); },
      setStatus(key, value) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setFooter(factory) {
        footer?.dispose();
        footer = factory?.({ requestRender() { paints++; } }, theme, {
          getGitBranch: () => nativeBranch, getExtensionStatuses: () => statuses,
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
  return { handlers, commands, ctx, entries, statuses, notices, pi, workingMessages, commandInfos, tools,
    set trusted(value) { trusted = value; },
    get editorFactory() { return editorFactory; }, set editorFactory(f) { editorFactory = f; },
    get footer() { return footer; }, get disposed() { return disposed; }, get paints() { return paints; },
  };
}

test("Git polling exposes staging details and outside Git stays quiet without a native branch fallback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-git-poll-"));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  let h;
  try {
    execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
    await writeFile(path.join(dir, "staged"), "hello");
    execFileSync("git", ["add", "staged"], { cwd: dir });
    await writeFile(path.join(dir, "staged"), "changed again");
    await mkdir(path.join(dir, "nested"));
    await writeFile(path.join(dir, "nested", "one"), "one");
    await writeFile(path.join(dir, "nested", "two"), "two");
    h = host([], dir, "tui", "fallback");
    h.ctx.model = { provider: "test", id: "test", contextWindow: 1000 };
    await h.handlers.get("session_start")({}, h.ctx);
    assert.match(h.footer.render(160)[0], /!/);
    await vi.waitFor(() => assert.match(h.footer.render(160)[0], /main \*/));
    await h.commands.get("status").handler("details", h.ctx);
    assert.match(h.notices.at(-1), /3 changed paths; 1 staged, 1 unstaged, 2 untracked, 0 conflicts/);
    assert.match(h.notices.at(-1), /Upstream: no upstream/);
    await h.handlers.get("session_shutdown")({}, h.ctx);
    await rm(path.join(dir, ".git"), { recursive: true, force: true });
    await h.handlers.get("session_start")({}, h.ctx);
    await vi.waitFor(() => assert.doesNotMatch(h.footer.render(160)[0], /!/));
    assert.match(h.footer.render(160)[0], new RegExp(path.basename(dir)));
    assert.doesNotMatch(h.footer.render(160)[0], /!|fallback|no upstream|changed/);
    await h.commands.get("status").handler("details", h.ctx);
    assert.match(h.notices.at(-1), /Git status: outside a Git repository/);
  } finally {
    await h?.handlers.get("session_shutdown")?.({}, h.ctx);
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a real linked worktree with broken common metadata is unavailable, not outside Git", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-broken-worktree-"));
  const main = path.join(dir, "main"), linked = path.join(dir, "linked");
  const oldGitDir = process.env.GIT_DIR;
  let h;
  try {
    execFileSync("git", ["init", "-b", "main", main], { stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Footer test", "-c", "user.email=footer@example.invalid", "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${os.devNull}`, "commit", "--allow-empty", "-m", "base"], { cwd: main, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "linked", linked], { cwd: main, stdio: "ignore" });
    h = host([], linked, "tui", "fallback");
    h.ctx.model = { provider: "test", id: "test", contextWindow: 1000 };
    await h.handlers.get("session_start")({}, h.ctx);
    await vi.waitFor(() => assert.match(h.footer.render(160)[0], /linked · \ue725 /));
    // Explicit admin-directory selection reproduces Git's non-discovery fatal;
    // the worktree still points at real but now invalid common metadata.
    process.env.GIT_DIR = path.join(main, ".git", "worktrees", "linked");
    await rm(path.join(main, ".git", "objects"), { recursive: true });
    assert.throws(() => execFileSync("git", ["status"], { cwd: linked, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] }),
      (error) => error.status === 128 && /fatal: not a git repository: .*worktrees/.test(error.stderr.toString()));
    await h.handlers.get("agent_settled")({}, h.ctx);
    await vi.waitFor(() => assert.match(h.footer.render(160)[0], /!/));
    assert.doesNotMatch(h.footer.render(160)[0], /no upstream|changed/);
    await h.commands.get("status").handler("details", h.ctx);
    assert.match(h.notices.at(-1), /Git status: git unavailable/);
  } finally {
    await h?.handlers.get("session_shutdown")?.({}, h.ctx);
    if (oldGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = oldGitDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("production polling preserves raw path bytes and UTF-8 tracking headers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-raw-status-"));
  const oldPath = process.env.PATH, oldHome = process.env.HOME;
  let h;
  try {
    const output = Buffer.concat([
      Buffer.from("# branch.oid aabbccddeeff\0# branch.head café/日本\0# branch.upstream origin/café/日本\0? "),
      Buffer.from([0xff, 0, 0x3f, 0x20, 0xfe, 0]),
    ]);
    await writeFile(path.join(dir, "git"), `#!${process.execPath}\nif (process.argv.includes("status")) {\nconst expected = ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--ahead-behind", "--untracked-files=all", "-z"];\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected) || process.env.LC_ALL !== "C" || process.env.GIT_OPTIONAL_LOCKS !== "0") process.exit(99);\nprocess.stdout.write(Buffer.from(${JSON.stringify(output.toString("base64"))}, "base64"));\n} else process.exit(1);\n`, { mode: 0o755 });
    process.env.PATH = dir; process.env.HOME = dir;
    h = host([], dir);
    h.ctx.model = { provider: "test", id: "test", contextWindow: 1000 };
    await h.handlers.get("session_start")({}, h.ctx);
    await vi.waitFor(() => assert.match(h.footer.render(240)[0], /café\/日本 \*/));
    await h.commands.get("status").handler("details", h.ctx);
    assert.match(h.notices.at(-1), /2 changed paths; 0 staged, 0 unstaged, 2 untracked/);
    assert.match(h.notices.at(-1), /Upstream: upstream missing \(origin\/café\/日本;/);
    assert.doesNotMatch(h.notices.at(-1), /0 ahead|no upstream/);
  } finally {
    await h?.handlers.get("session_shutdown")?.({}, h.ctx);
    for (const [key, value] of [["PATH", oldPath], ["HOME", oldHome]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("Git polling distinguishes explicit non-repository errors from actual failures", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-git-errors-"));
  const oldPath = process.env.PATH, oldHome = process.env.HOME, oldLocale = process.env.LC_ALL;
  process.env.HOME = dir; process.env.LC_ALL = "fr_FR.UTF-8";
  let h;
  try {
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    process.env.PATH = bin;
    for (const [stderr, code, quiet] of [
      [undefined, 0, false], // Missing executable.
      ["fatal: permission denied\n", 128, false],
      ["fatal: not a git repository: /tmp/main/.git/worktrees/linked\n", 128, false],
      ["fatal: not a git repository (or any of the parent directories): .git\n", 1, false],
      ["fatal: not a git repository (or any of the parent directories): .git\n", 128, true],
      ["fatal: not a git repository (or any parent up to mount point /Volumes/test)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n", 128, true],
      ["", 0, false], // Successful but empty/malformed status.
    ]) {
      const executable = path.join(bin, "git");
      const stub = async (message, exitCode) => {
        if (message === undefined) await rm(executable, { force: true });
        else await writeFile(executable, `#!${process.execPath}\nif (process.env.LC_ALL !== "C" && process.argv.includes("status")) process.exit(99);\nprocess.stderr.write(${JSON.stringify(message)}); process.exit(${exitCode});\n`, { mode: 0o755 });
      };
      // Start from the opposite measured state so initial unavailable/other
      // async paints cannot satisfy the outcome assertion prematurely.
      await stub("fatal: not a git repository (or any of the parent directories): .git\n", 128);
      h = host([], dir, "tui", "fallback");
      h.ctx.model = { provider: "test", id: "test", contextWindow: 1000 };
      await h.handlers.get("session_start")({}, h.ctx);
      await vi.waitFor(() => assert.doesNotMatch(h.footer.render(160)[0], /!/));
      if (quiet) {
        await stub(undefined, 0);
        await h.handlers.get("agent_settled")({}, h.ctx);
        await vi.waitFor(() => assert.match(h.footer.render(160)[0], /!/));
      }
      await stub(stderr, code);
      await h.handlers.get("agent_settled")({}, h.ctx);
      await vi.waitFor(() => {
        if (quiet) assert.doesNotMatch(h.footer.render(160)[0], /!/);
        else assert.match(h.footer.render(160)[0], /!/);
      });
      const row = h.footer.render(160)[0];
      assert.match(row, new RegExp(path.basename(dir)));
      assert.doesNotMatch(row, /no upstream|changed|conflict/);
      if (quiet) assert.doesNotMatch(row, /!/);
      else assert.match(row, /!/);
      await h.commands.get("status").handler("details", h.ctx);
      assert.match(h.notices.at(-1), quiet ? /outside a Git repository/ : /Git status: git unavailable/);
      await h.handlers.get("session_shutdown")({}, h.ctx);
      h = undefined;
    }
  } finally {
    await h?.handlers.get("session_shutdown")?.({}, h.ctx);
    for (const [key, value] of [["PATH", oldPath], ["HOME", oldHome], ["LC_ALL", oldLocale]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("factory is inert in non-TUI modes and does not replace the editor", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const h = host([], os.tmpdir(), mode);
    await h.handlers.get("session_start")({}, h.ctx);
    assert.equal(h.footer, undefined);
    await h.handlers.get("turn_start")({}, h.ctx);
    await h.handlers.get("session_shutdown")({}, h.ctx);
  }
});

// Hold OAuth lookup open so shutdown must cancel both owned timer handles.
// All quota IO is isolated; saved callbacks can be invoked after cancellation.
async function withLifecycleHost(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-cleanup-"));
  const oldHome = process.env.HOME, oldCache = process.env.CLAUDE_STATUSLINE_CACHE_DIR;
  const real = {
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, fetch: globalThis.fetch,
  };
  const intervals = new Set(), timeouts = new Set(), savedIntervals = [], savedTimeouts = [], branches = [];
  const steps = [], failures = new Map(), contexts = [], tokenResolvers = [], fetches = [];
  const aborted = new Set(), killed = new Set();
  const cleanup = (step) => { steps.push(step); if (failures.has(step)) throw failures.get(step); };
  process.env.HOME = dir; process.env.CLAUDE_STATUSLINE_CACHE_DIR = dir;
  globalThis.setInterval = (callback) => {
    const timer = { callback, unref() {} };
    intervals.add(timer); savedIntervals.push(timer); return timer;
  };
  globalThis.clearInterval = (timer) => { intervals.delete(timer); cleanup("interval"); };
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms !== 5_000) return real.setTimeout(callback, ms, ...args);
    const timer = { callback };
    timeouts.add(timer); savedTimeouts.push(timer); return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (!savedTimeouts.includes(timer)) return real.clearTimeout(timer);
    timeouts.delete(timer); cleanup("timeout");
  };
  globalThis.fetch = async (...args) => { fetches.push(args); throw new Error("Unexpected quota fetch"); };
  const realAbort = AbortController.prototype.abort, realKill = ChildProcess.prototype.kill;
  const abortSpy = vi.spyOn(AbortController.prototype, "abort").mockImplementation(function (...args) {
    aborted.add(this); realAbort.apply(this, args); cleanup("abort");
  });
  const killSpy = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (...args) {
    killed.add(this); const result = realKill.apply(this, args); cleanup("child"); return result;
  });
  const h = host([], dir);
  class Editor {
    borderColor = (text) => text;
    renderTopBorder() { return "original-top"; }
    renderBottomBorder() { return "original-bottom"; }
  }
  const originalEditor = () => new Editor();
  h.editorFactory = originalEditor;
  h.ctx.getContextUsage = () => ({ tokens: 100000, percent: 50, contextWindow: 200000 });
  h.ctx.modelRegistry.getApiKeyForProvider = () => new Promise((resolve) => tokenResolvers.push(resolve));
  const { setFooter, getEditorComponent, setEditorComponent } = h.ctx.ui;
  h.ctx.ui.setFooter = (factory) => {
    if (!factory) cleanup("footer");
    setFooter(factory && ((tui, paint, data) => factory(tui, paint, {
      ...data,
      onBranchChange(callback) {
        branches.push(callback);
        const unsubscribe = data.onBranchChange(callback);
        return () => { cleanup("dispose"); unsubscribe(); };
      },
    })));
  };
  h.ctx.ui.getEditorComponent = () => { cleanup("getEditor"); return getEditorComponent(); };
  h.ctx.ui.setEditorComponent = (factory) => { cleanup("setEditor"); setEditorComponent(factory); };
  const newContext = () => {
    const state = { valid: true, reads: 0 };
    contexts.push(state);
    const ctx = new Proxy(h.ctx, {
      get(target, key, receiver) {
        state.reads++;
        if (!state.valid) throw new Error("invalidated ctx");
        return Reflect.get(target, key, receiver);
      },
    });
    return { ctx, state };
  };
  try {
    await run({ h, newContext, originalEditor, intervals, timeouts, savedIntervals, savedTimeouts, branches, steps, failures, aborted, killed, tokenResolvers, fetches });
  } finally {
    failures.clear();
    for (const state of contexts) state.valid = true;
    try { h.handlers.get("session_shutdown")({}, h.ctx); } finally {
      for (const resolve of tokenResolvers) resolve(undefined);
      await new Promise((resolve) => setImmediate(resolve));
      abortSpy.mockRestore(); killSpy.mockRestore();
      Object.assign(globalThis, real);
      for (const [key, value] of [["HOME", oldHome], ["CLAUDE_STATUSLINE_CACHE_DIR", oldCache]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function savedLifecycleCallbacks(f) {
  const factory = f.h.editorFactory, editor = factory(), footer = f.h.footer;
  const tick = f.savedIntervals.at(-1).callback, timeout = f.savedTimeouts.at(-1).callback;
  const branch = f.branches.at(-1);
  return () => {
    tick(); timeout(); branch();
    assert.deepEqual(footer.render(120), []);
    footer.dispose();
    assert.equal(editor.renderTopBorder(10, 0), "original-top");
    assert.equal(editor.renderBottomBorder(10, 0), "original-bottom");
    const fallback = factory({ requestRender() {} }, { borderColor: (text) => text }, { matches: () => false });
    assert.equal(fallback.renderTopBorder(10, 0), "──────────");
  };
}

for (const fault of ["dispose", "footer", "all"]) {
  test(`shutdown completes remaining cleanup after ${fault} errors and leaves saved callbacks inert`, async () => {
    await withLifecycleHost(async (f) => {
      const { h, intervals, timeouts, steps, failures, aborted, killed } = f;
      const old = f.newContext();
      h.handlers.get("session_start")({}, old.ctx);
      const invokeSaved = savedLifecycleCallbacks(f);
      assert.equal(intervals.size, 2); assert.equal(timeouts.size, 1);
      const failing = fault === "all" ? ["abort", "child", "dispose", "footer"] : [fault];
      for (const step of failing) failures.set(step, new Error(`${step} failed`));
      steps.length = 0;
      const expectedSteps = ["interval", "interval", "timeout", "abort", "child", "child", "child", "dispose", "footer"];
      const expectedErrors = expectedSteps.filter((step) => failures.has(step)).map((step) => failures.get(step));
      assert.throws(() => h.handlers.get("session_shutdown")({}, old.ctx), (error) => {
        if (expectedErrors.length === 1) assert.equal(error, expectedErrors[0]);
        else { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, expectedErrors); }
        return true;
      });
      assert.deepEqual(steps, expectedSteps, "timers cancel before every fallible cleanup attempt");
      assert.equal(intervals.size, 0); assert.equal(timeouts.size, 0);
      assert.equal(aborted.size, 1); assert.equal(killed.size, 3);

      old.state.valid = false;
      steps.length = 0;
      const reads = old.state.reads, paints = h.paints;
      assert.doesNotThrow(invokeSaved);
      assert.doesNotThrow(() => h.handlers.get("session_compact")({}, old.ctx));
      assert.doesNotThrow(() => h.handlers.get("session_shutdown")({}, old.ctx));
      assert.equal(old.state.reads, reads); assert.equal(h.paints, paints);
      assert.deepEqual(steps, [], "failed disposal and repeated shutdown are one-shot");
      failures.clear();
      const fresh = f.newContext();
      h.handlers.get("session_start")({}, fresh.ctx);
      const freshReads = fresh.state.reads, freshPaints = h.paints, freshAborts = aborted.size, freshKills = killed.size;
      steps.length = 0;
      assert.doesNotThrow(invokeSaved);
      assert.equal(old.state.reads, reads); assert.equal(fresh.state.reads, freshReads);
      assert.equal(h.paints, freshPaints); assert.equal(aborted.size, freshAborts); assert.equal(killed.size, freshKills);
      assert.deepEqual(steps, [], "stale timeouts cannot abort their old controller again");
      assert.equal(intervals.size, 2); assert.equal(timeouts.size, 1);
      assert.ok(h.footer.render(120).length > 0);
    });
  });
}

for (const invalidated of [false, true]) {
  test(`session_start activates a fresh context despite prior disposal failure${invalidated ? " and invalidated UI" : ""}`, async () => {
    await withLifecycleHost(async (f) => {
      const old = f.newContext();
      f.h.handlers.get("session_start")({}, old.ctx);
      const invokeSaved = savedLifecycleCallbacks(f);
      old.state.valid = !invalidated;
      const failure = new Error("prior disposal failed");
      f.failures.set("dispose", failure);
      f.steps.length = 0;
      const fresh = f.newContext();
      assert.doesNotThrow(() => f.h.handlers.get("session_start")({}, fresh.ctx));
      assert.equal(f.intervals.size, 2); assert.equal(f.timeouts.size, 1);
      assert.equal(f.aborted.size, 1); assert.equal(f.killed.size, 3);
      assert.equal(f.h.disposed, 0, "prior unsubscribe threw, but its local disposer detached first");
      assert.ok(f.h.footer.render(120).length > 0);
      const reads = old.state.reads, freshReads = fresh.state.reads, paints = f.h.paints, cleanupSteps = f.steps.slice();
      assert.doesNotThrow(invokeSaved);
      assert.equal(old.state.reads, reads); assert.equal(fresh.state.reads, freshReads); assert.equal(f.h.paints, paints);
      assert.deepEqual(f.steps, cleanupSteps);
      assert.deepEqual(f.steps.slice(0, 3), ["interval", "interval", "timeout"]);
      f.failures.clear();
      f.h.handlers.get("session_shutdown")({}, fresh.ctx);
      assert.equal(f.intervals.size, 0); assert.equal(f.timeouts.size, 0);
      assert.equal(f.h.footer, undefined);
    });
  });
}

// Pi resets the editor after session_shutdown. Restoring the wrapped factory
// there made Pi build an editor from it at once, after its owners had shut down
// (pi-vim threw "session is no longer active" on every /clear).
test("shutdown leaves the editor component alone and the next start does not stack wrappers", async () => {
  await withLifecycleHost(async (f) => {
    let built = 0;
    f.h.editorFactory = () => { built++; return f.originalEditor(); };
    const inner = f.h.editorFactory;
    const old = f.newContext();
    f.h.handlers.get("session_start")({}, old.ctx);
    const wrapper = f.h.editorFactory;
    assert.notEqual(wrapper, inner);
    f.steps.length = 0;
    f.h.handlers.get("session_shutdown")({}, old.ctx);
    assert.ok(!f.steps.includes("getEditor") && !f.steps.includes("setEditor"), "shutdown does not touch the editor");
    assert.equal(f.h.editorFactory, wrapper);
    assert.equal(built, 0, "no editor is built from the outgoing factories");
    old.state.valid = false;
    const fresh = f.newContext();
    f.h.handlers.get("session_start")({}, fresh.ctx);
    const editor = f.h.editorFactory({ requestRender() {} }, { borderColor: (text) => text }, { matches: () => false });
    assert.equal(built, 1, "the fresh wrapper calls the original factory once, not a stale wrapper");
    assert.ok(editor);
  });
});

test("a saved editor wrapper never invokes a foreign factory bound to an invalidated context", async () => {
  await withLifecycleHost(async (f) => {
    const old = f.newContext();
    f.h.editorFactory = () => { old.ctx.getContextUsage(); return f.originalEditor(); };
    f.h.handlers.get("session_start")({}, old.ctx);
    const invokeSaved = savedLifecycleCallbacks(f);
    f.h.handlers.get("session_shutdown")({}, old.ctx);
    old.state.valid = false;
    const reads = old.state.reads;
    assert.doesNotThrow(invokeSaved);
    assert.equal(old.state.reads, reads);
    const fresh = f.newContext();
    f.h.handlers.get("session_start")({}, fresh.ctx);
    const freshReads = fresh.state.reads;
    assert.doesNotThrow(invokeSaved);
    assert.equal(old.state.reads, reads); assert.equal(fresh.state.reads, freshReads);
  });
});

test("an old OAuth lookup resolving after reload cannot fetch or clear the fresh timeout/controller", async () => {
  await withLifecycleHost(async (f) => {
    const old = f.newContext();
    f.h.handlers.get("session_start")({}, old.ctx);
    const oldTimeout = f.savedTimeouts.at(-1);
    f.h.handlers.get("session_shutdown")({}, old.ctx);
    old.state.valid = false;
    const fresh = f.newContext();
    f.h.handlers.get("session_start")({}, fresh.ctx);
    const currentTimeout = f.savedTimeouts.at(-1);
    f.tokenResolvers[0](jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "old-account" } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.fetches, []);
    assert.equal(f.timeouts.size, 1); assert.ok(f.timeouts.has(currentTimeout));
    assert.ok(!f.timeouts.has(oldTimeout));
    assert.equal(f.intervals.size, 2);
    assert.equal(f.aborted.size, 1);
    currentTimeout.callback();
    assert.equal(f.aborted.size, 2, "the fresh controller remains owned after old finally runs");
    f.h.handlers.get("session_shutdown")({}, fresh.ctx);
    assert.equal(f.timeouts.size, 0); assert.equal(f.intervals.size, 0);
  });
});

test("normal repeated shutdown and reload leave fresh timers and no stale callbacks", async () => {
  await withLifecycleHost(async (f) => {
    const saved = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const current = f.newContext();
      f.h.handlers.get("session_start")({}, current.ctx);
      assert.equal(f.intervals.size, 2); assert.equal(f.timeouts.size, 1);
      const reads = current.state.reads, paints = f.h.paints, aborts = f.aborted.size, cleanupSteps = f.steps.slice();
      for (const invoke of saved) assert.doesNotThrow(invoke);
      assert.equal(current.state.reads, reads); assert.equal(f.h.paints, paints); assert.equal(f.aborted.size, aborts);
      assert.deepEqual(f.steps, cleanupSteps);
      f.savedIntervals.at(-1).callback();
      assert.ok(current.state.reads > reads); assert.ok(f.h.paints > paints, "current timer still works");
      saved.push(savedLifecycleCallbacks(f));
      f.h.handlers.get("session_shutdown")({}, current.ctx);
      assert.equal(f.intervals.size, 0); assert.equal(f.timeouts.size, 0);
      assert.equal(f.h.footer, undefined);
      current.state.valid = false;
      const stoppedReads = current.state.reads, stoppedPaints = f.h.paints;
      assert.doesNotThrow(() => f.h.handlers.get("session_shutdown")({}, current.ctx));
      for (const invoke of saved) assert.doesNotThrow(invoke);
      assert.equal(current.state.reads, stoppedReads); assert.equal(f.h.paints, stoppedPaints);
      assert.equal(f.h.disposed, cycle + 1);
    }
  });
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
    assert.equal(timers.size, 2, "the footer tick and the MCP poll");
    for (const variant of ["", "\ufe0e", "\ufe0f"]) {
      const status = `\x1b[36m\u{1f50c}${variant} MCP: 5 connected\x1b[39m`;
      h.statuses.set("mcp", status);
      const rendered = h.footer.render(120).join("\n");
      assert.match(rendered, /\uf1e6(?:\x1b\[[0-9;]*m)* \x1b\[36mMCP: 5 connected\x1b\[39m/, "the flat plug leads the row; color/text preserved");
      assert.doesNotMatch(rendered, /\u{1f50c}/u);
      assert.equal(h.statuses.get("mcp"), status, "presentation does not mutate the extension status");
      for (let width = 1; width <= 240; width++) {
        assert.ok(h.footer.render(width).every((row) => visibleWidth(row) <= width));
      }
    }
    assert.match(h.footer.render(120).join("\n"), /PLAN mode/);
    assert.match(h.footer.render(120)[0], /!/, "unmeasured Git state is not clean");
    assert.doesNotMatch(plain(h.footer.render(120)[1]), /\(auto\)/);
    h.statuses.set("auto-effort", "effort: xhigh (auto)");
    assert.match(plain(h.footer.render(120)[1]), /reasoning xhigh · auto/);
    assert.doesNotMatch(h.footer.render(120).join("\n"), /effort:/);
    h.statuses.delete("auto-effort");
    assert.doesNotMatch(plain(h.footer.render(120)[1]), /\(auto\)/);
    await vi.waitFor(() => assert.equal(fetches.length, 1));
    assert.equal(fetches[0].url, "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(fetches[0].headers["chatgpt-account-id"], "acct-1");
    assert.match(h.footer.render(120).join("\n"), /Codex\s+week 25% used · resets in 1d0h · gpt-reserve 0% used/);
    assert.doesNotMatch(h.footer.render(120).join("\n"), /Claude/);
    await h.handlers.get("after_provider_response")({ headers: {
      "x-codex-primary-used-percent": "45", "x-codex-primary-window-minutes": "10080" } }, h.ctx);
    assert.match(h.footer.render(120).join("\n"), /Codex\s+week 45% used.*gpt-reserve 0%/);
    for (const timer of timers) timer.callback();
    await settle();
    assert.equal(fetches.length, 1, "usage endpoint is throttled");
    await h.handlers.get("model_select")({}, h.ctx);
    assert.match(h.footer.render(120).join("\n"), /week 45%/, "account limits survive a model switch");
    await h.commands.get("status").handler("all", h.ctx);
    assert.match(h.footer.render(120).join("\n"), /Claude\s+limits unavailable/);
    await h.commands.get("status").handler("native", h.ctx);
    assert.equal(h.footer, undefined);
    assert.ok(h.disposed >= 2);
    await h.handlers.get("session_shutdown")({}, h.ctx);
    assert.equal(timers.size, 0);
    await h.handlers.get("session_start")({}, h.ctx);
    assert.equal(h.footer, undefined, "native mode restored from session state");
    assert.equal(timers.size, 2);
    await h.commands.get("status").handler("on", h.ctx);
    assert.ok(h.footer);
    h.ctx.model = { provider: "radius", id: "balanced", reasoning: false };
    await h.handlers.get("model_select")({}, h.ctx);
    assert.doesNotMatch(h.footer.render(120).join("\n"), /Claude|Codex|45%/);
    await h.commands.get("status").handler("all", h.ctx);
    await vi.waitFor(() => assert.match(h.footer.render(120).join("\n"), /Codex\s+week/, "/status all shows Codex on other providers"));
    await h.commands.get("status").handler("on", h.ctx);
    h.entries.push({ type: "usage", usage: usage(4) });
    for (const timer of timers) timer.callback();
    assert.doesNotMatch(h.footer.render(120).join("\n"), /cost/);
    await vi.waitFor(() => assert.doesNotMatch(h.footer.render(120)[0], /!/));
    await h.commands.get("status").handler("details", h.ctx);
    const details = h.notices.at(-1);
    assert.match(details, /Context: unknown of 200k tokens; usage unknown/);
    assert.match(details, /Cache reuse: not measured/);
    assert.match(details, /Estimated session cost: \$4\.00/);
    assert.match(details, /Recorded tokens: 100 input, 20 output, 300 cache reads, 100 cache writes/);
    assert.match(details, /Tracked Git changes:/);
    assert.match(details, /Git status: outside a Git repository/);
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

test("Claude limits use Pi's own subscription login, with no Claude Code login, and response headers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-claude-"));
  const oldCache = process.env.CLAUDE_STATUSLINE_CACHE_DIR;
  process.env.CLAUDE_STATUSLINE_CACHE_DIR = dir;
  const realFetch = globalThis.fetch, fetches = [];
  const reset = new Date(Date.now() + 3 * 3600_000).toISOString();
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, headers: init.headers });
    const body = JSON.stringify({ five_hour: { utilization: 20, resets_at: reset }, seven_day: { utilization: 40, resets_at: reset } });
    return { ok: true, text: async () => body };
  };
  let h;
  try {
    h = host([], dir);
    h.ctx.model = { provider: "anthropic", id: "claude-opus-5", contextWindow: 200000, reasoning: true };
    h.ctx.modelRegistry.getApiKeyForProvider = async (p) => p === "anthropic" ? "sk-ant-oat01-pi" : undefined;
    await h.handlers.get("session_start")({}, h.ctx);
    await vi.waitFor(() => assert.equal(fetches.length, 1));
    assert.equal(fetches[0].url, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(fetches[0].headers.Authorization, "Bearer sk-ant-oat01-pi");
    await vi.waitFor(() => assert.match(plain(h.footer.render(160).join("\n")), /Claude\s+5h 20% used.*week 40% used/));
    assert.doesNotMatch(plain(h.footer.render(160).join("\n")), /stale/);
    await h.handlers.get("after_provider_response")({ headers: {
      "anthropic-ratelimit-unified-7d-utilization": "0.45" } }, h.ctx);
    assert.match(plain(h.footer.render(160).join("\n")), /5h 20% used.*week 45% used/);
    // A later cache read must not roll back the newer header reading.
    await h.handlers.get("model_select")({}, h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fetches.length, 1, "the Pi usage cache is reused within its TTL");
    assert.match(plain(h.footer.render(160).join("\n")), /week 45% used/);
  } finally {
    if (h) await h.handlers.get("session_shutdown")({}, h.ctx);
    globalThis.fetch = realFetch;
    if (oldCache === undefined) delete process.env.CLAUDE_STATUSLINE_CACHE_DIR; else process.env.CLAUDE_STATUSLINE_CACHE_DIR = oldCache;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex limits are shared across sessions and follow the streamed rate-limit event", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-codex-"));
  const oldXdg = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  const realFetch = globalThis.fetch, fetches = [];
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, headers: init.headers });
    return { ok: true, json: async () => codexUsage(25, Date.now() + 30_000) };
  };
  const hosts = [];
  try {
    const first = host([], dir); hosts.push(first);
    await first.handlers.get("session_start")({}, first.ctx);
    await vi.waitFor(() => assert.match(first.footer.render(160).join("\n"), /Codex\s+week 25% used.*gpt-reserve 0%/));
    assert.equal(fetches.length, 1);
    await first.handlers.get("provider_stream_event")({ provider: "openai-codex", data: { type: "response.created" } }, first.ctx);
    await first.handlers.get("provider_stream_event")({ provider: "openai-codex", data: { type: "codex.rate_limits",
      rate_limits: { primary: { used_percent: 46, window_minutes: 10080, reset_at: Date.now() / 1000 + 86400 } }, additional_rate_limits: null } }, first.ctx);
    assert.match(first.footer.render(160).join("\n"), /Codex\s+week 46% used.*gpt-reserve 0%/, "named pools survive the event");
    // A second session on the same account reads the shared reading instead of fetching.
    await vi.waitFor(async () => assert.match(await (await import("node:fs/promises")).readFile(path.join(dir, "pi-status-footer", "codex-usage-acct-1.json"), "utf8"), /"used_percent":46/));
    const second = host([], dir); hosts.push(second);
    await second.handlers.get("session_start")({}, second.ctx);
    await vi.waitFor(() => assert.match(second.footer.render(160).join("\n"), /Codex\s+week 46% used.*gpt-reserve 0%/));
    assert.equal(fetches.length, 1, "the shared reading is fresh, so no second fetch");
  } finally {
    for (const h of hosts) await h.handlers.get("session_shutdown")({}, h.ctx);
    globalThis.fetch = realFetch;
    if (oldXdg === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = oldXdg;
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
  const row = mod.renderFooter({ ...fixture(), borderGauge: true }, 160, theme)[2];
  assert.match(row, /Context\s+28% used/);
  assert.doesNotMatch(row, /[━─]/);
});

test("startup retains foreign usage status and tree navigation restores destination preferences", async () => {
  const entries = [{ type: "custom", customType: "personal-status-footer", data: { enabled: false, showAll: false } }];
  const h = host(entries);
  h.ctx.model = { provider: "test", id: "test", contextWindow: 1000 };
  h.statuses.set("usage", "Another producer's usage notice");
  try {
    await h.handlers.get("session_start")({}, h.ctx);
    assert.equal(h.statuses.get("usage"), "Another producer's usage notice");
    assert.equal(h.footer, undefined);
    h.ctx.sessionManager.getBranch = () => [];
    await h.handlers.get("session_tree")({}, h.ctx);
    assert.ok(h.footer, "destination branch without an override restores suite footer");
    h.ctx.sessionManager.getBranch = () => entries;
    await h.handlers.get("session_tree")({}, h.ctx);
    assert.equal(h.footer, undefined, "destination branch with native override uses native footer");
    assert.equal(h.statuses.get("usage"), "Another producer's usage notice");
  } finally { await h.handlers.get("session_shutdown")({}, h.ctx); }
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

test("working-row text: tokens with thousands separators, elapsed after the threshold, pi's default otherwise", () => {
  assert.equal(mod.formatElapsed(0), "0s");
  assert.equal(mod.formatElapsed(999), "0s");
  assert.equal(mod.formatElapsed(12_400), "12s");
  assert.equal(mod.formatElapsed(123_000), "2m 3s");
  assert.equal(mod.formatElapsed(3_723_000), "1h 2m 3s");
  assert.equal(mod.workingMessage(0, 0), undefined, "nothing to add leaves pi's own message");
  assert.equal(mod.workingMessage(0, 2_999), undefined);
  assert.equal(mod.workingMessage(0, 3_000), "Working (3s)");
  assert.equal(mod.workingMessage(1234, 0), "Working (\u2193 1,234 tokens \u00b7 0s)", "any tokens bring the timer along");
  assert.equal(mod.workingMessage(5, 12_000), "Working (\u2193 5 tokens \u00b7 12s)");
  assert.equal(mod.workingMessage(1, 0), "Working (\u2193 1 token \u00b7 0s)");
  assert.doesNotMatch(mod.workingMessage(5, 12_000), /\(.*\(/, "no nested parentheses");
});

test("working-row tokens: a chars/4 estimate of text and thinking until the provider reports output", () => {
  const stats = new mod.WorkingStats();
  const partial = (usage) => ({ content: [], usage });
  assert.equal(stats.tokens(), 0);
  stats.apply({ type: "start", partial: partial() });
  stats.apply({ type: "thinking_start", contentIndex: 0, partial: partial() });
  stats.apply({ type: "thinking_delta", contentIndex: 0, delta: "12345678", partial: partial() });
  assert.equal(stats.tokens(), 2, "thinking counts");
  stats.apply({ type: "text_start", contentIndex: 2, partial: partial() });
  stats.apply({ type: "text_delta", contentIndex: 2, delta: "abcd", partial: partial() });
  assert.equal(stats.tokens(), 3, "a tool call at index 1 leaves a sparse hole");
  stats.apply({ type: "text_end", contentIndex: 2, content: "abcdefgh", partial: partial() });
  assert.equal(stats.tokens(), 4, "the final text replaces the deltas instead of adding to them");
  stats.apply({ type: "toolcall_delta", contentIndex: 3, delta: "{}", partial: partial({ output: 0 }) });
  assert.equal(stats.tokens(), 4, "zero or absent usage keeps the estimate");
  stats.apply({ type: "toolcall_delta", contentIndex: 3, delta: "{}", partial: partial({ output: 1234.4 }) });
  assert.equal(stats.tokens(), 1234, "the provider's count wins once known");
  stats.apply({ type: "text_delta", contentIndex: 2, delta: "more", partial: partial() });
  assert.equal(stats.tokens(), 1234, "and is not lost on an update without usage");
  stats.apply({ type: "done", reason: "stop", message: { content: [{ type: "text", text: "x".repeat(40) }, { type: "thinking", thinking: "y".repeat(8) }], usage: { output: 0 } } });
  assert.equal(stats.tokens(), 12, "done restarts from the final message");
  stats.apply({ type: "error", reason: "aborted", error: { content: [], usage: {} } });
  assert.equal(stats.tokens(), 0);
  stats.apply({ type: "start", partial: { content: [{ type: "text", text: "12345678" }], usage: { output: 9 } } });
  assert.equal(stats.tokens(), 9, "a resumed partial restores both the estimate and the usage");
  stats.reset();
  assert.equal(stats.tokens(), 0);
});

test("working row drives pi's indicator only while a run streams, and restores the default on every exit", async () => {
  const clock = vi.spyOn(Date, "now");
  let t = now;
  clock.mockImplementation(() => t);
  const h = host();
  const partial = (text, output) => ({ content: [{ type: "text", text }], usage: output === undefined ? {} : { output } });
  try {
    await h.handlers.get("session_start")({}, h.ctx);
    await h.handlers.get("before_agent_start")({}, h.ctx);
    await h.handlers.get("turn_start")({}, h.ctx);
    assert.deepEqual(h.workingMessages, [], "no tokens and under the threshold: pi's own message stays");
    t += 1_000;
    await h.handlers.get("message_update")({ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(12), partial: partial("x".repeat(12)) } }, h.ctx);
    assert.deepEqual(h.workingMessages, ["Working (\u2193 3 tokens \u00b7 1s)"]);
    await h.handlers.get("message_update")({ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "", partial: partial("x".repeat(12)) } }, h.ctx);
    assert.equal(h.workingMessages.length, 1, "an unchanged message is not re-sent");
    t += 11_000;
    await h.handlers.get("message_update")({ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y", partial: partial("x".repeat(13), 1234) } }, h.ctx);
    assert.equal(h.workingMessages.at(-1), "Working (\u2193 1,234 tokens \u00b7 12s)", "provider usage replaces the estimate; elapsed counts from the agent start");
    await h.handlers.get("turn_end")({}, h.ctx);
    assert.equal(h.workingMessages.at(-1), undefined, "the turn's end restores pi's default at once");
    assert.equal(h.workingMessages.length, 3);
    // The second turn of the same run keeps the run's clock and starts a fresh token count.
    t += 4_000;
    await h.handlers.get("turn_start")({}, h.ctx);
    assert.equal(h.workingMessages.at(-1), "Working (16s)", "past the threshold the timer shows alone");
    await h.handlers.get("agent_end")({}, h.ctx);
    assert.equal(h.workingMessages.at(-1), undefined);
    assert.equal(h.workingMessages.length, 5);
    // A new run starts its clock over.
    await h.handlers.get("before_agent_start")({}, h.ctx);
    await h.handlers.get("turn_start")({}, h.ctx);
    assert.equal(h.workingMessages.length, 5);
    await h.handlers.get("message_update")({ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "zzzz", partial: partial("zzzz") } }, h.ctx);
    assert.equal(h.workingMessages.at(-1), "Working (\u2193 1 token \u00b7 0s)");
    // Turning the row off mid-run restores pi's message and stays off across a reload.
    await h.commands.get("status").handler("working off", h.ctx);
    assert.equal(h.workingMessages.at(-1), undefined);
    assert.match(h.notices.at(-1), /Working row disabled/);
    const sent = h.workingMessages.length;
    await h.handlers.get("message_update")({ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "zzzz", partial: partial("zzzzzzzz") } }, h.ctx);
    await h.handlers.get("turn_end")({}, h.ctx);
    assert.equal(h.workingMessages.length, sent, "disabled: pi's indicator is left alone");
    assert.deepEqual(h.entries.at(-1).data, { enabled: true, showAll: false, working: false, mcp: true });
    await h.handlers.get("session_shutdown")({}, h.ctx);
    await h.handlers.get("session_start")({}, h.ctx);
    await h.handlers.get("before_agent_start")({}, h.ctx);
    await h.handlers.get("turn_start")({}, h.ctx);
    await h.handlers.get("message_update")({ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "zzzz", partial: partial("zzzz") } }, h.ctx);
    assert.equal(h.workingMessages.length, sent, "the preference survives reload");
    await h.commands.get("status").handler("details", h.ctx);
    assert.match(h.notices.at(-1), /Working row: off/);
    await h.commands.get("status").handler("working on", h.ctx);
    await h.handlers.get("turn_end")({}, h.ctx);
    await h.handlers.get("turn_start")({}, h.ctx);
    await h.handlers.get("message_update")({ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "zzzz", partial: partial("zzzz") } }, h.ctx);
    assert.equal(h.workingMessages.at(-1), "Working (\u2193 1 token \u00b7 0s)", "the next turn after re-enabling shows again");
    // Shutdown mid-run also restores pi's message.
    await h.handlers.get("session_shutdown")({}, h.ctx);
    assert.equal(h.workingMessages.at(-1), undefined);
    await h.commands.get("status").handler("bogus", h.ctx);
    assert.match(h.notices.at(-1), /working on\|off\|mcp on\|off/);
  } finally {
    clock.mockRestore();
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  }
});

test("MCP counting: namespaces, hidden tools, built-in source precedence, name normalization and /mcp ownership", () => {
  assert.equal(mod.mcpNamespaceServer("mcp__docs"), "docs");
  assert.equal(mod.mcpNamespaceServer("mcp__"), undefined);
  assert.equal(mod.mcpNamespaceServer("other"), undefined);
  assert.equal(mod.normalizeMcpServerName(" my-db "), "my_db");
  const builtin = { path: "builtin:mcp" }, foreign = { path: "/x/pi-mcp-adapter/index.ts" };
  const tool = (namespace, sourceInfo, exposure = "codemode") => ({ namespace: { name: namespace }, sourceInfo, exposure });
  assert.deepEqual(mod.connectedMcpServers([
    tool("mcp__docs", builtin), tool("mcp__docs", builtin, "direct"), tool("mcp__my_db", builtin),
    tool("mcp__secret", builtin, "hidden"), tool("mcp__adapter", foreign), { name: "read", sourceInfo: builtin },
  ]), ["docs", "my_db"]);
  assert.deepEqual(mod.connectedMcpServers([tool("mcp__a", foreign), tool("mcp__b", { path: undefined })]), ["a", "b"], "without a built-in source the namespace decides");
  assert.deepEqual(mod.connectedMcpServers([]), []);
  assert.deepEqual(mod.countMcp(["docs", "my_db"], ["docs", "my-db", "off"]), { connected: 2, total: 3 });
  assert.deepEqual(mod.countMcp(["stray"], []), { connected: 1, total: 1 }, "a connected server missing from mcp.json still counts");
  assert.equal(mod.countMcp([], []), undefined);
  assert.equal(mod.formatMcpChip(mod.countMcp(["a"], ["a", "b"])), "MCP 1/2");
  assert.equal(mod.formatMcpChip(undefined), undefined);
  assert.equal(mod.builtinMcpOwnsCommand([{ name: "mcp", sourceInfo: builtin }, { name: "status", sourceInfo: foreign }]), true);
  assert.equal(mod.builtinMcpOwnsCommand([{ name: "mcp", sourceInfo: builtin }, { name: "mcp", sourceInfo: foreign }]), false, "a takeover of /mcp yields");
  assert.equal(mod.builtinMcpOwnsCommand([]), false, "no /mcp at all means no built-in MCP");
});

test("MCP configuration: enabled entries from the user file and the trusted project's, cached by mtime", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-mcp-"));
  try {
    const reader = new mod.McpConfigReader();
    const file = path.join(dir, "mcp.json");
    assert.equal(await reader.read(file), undefined, "missing file");
    await writeFile(file, "{not json");
    assert.equal(await reader.read(file), undefined, "broken file");
    await writeFile(file, JSON.stringify({ mcpServers: { docs: { url: "https://x" }, "my-db": { command: "db" }, off: { enabled: false }, bad: null, list: [] } }));
    assert.deepEqual(await reader.read(file), ["docs", "my-db"]);
    await mkdir(path.join(dir, "project", ".pi"), { recursive: true });
    await writeFile(path.join(dir, "project", ".pi", "mcp.json"), JSON.stringify({ mcpServers: { docs: {}, local: {} } }));
    assert.deepEqual(await reader.configured({ agentDir: dir, cwd: path.join(dir, "project"), projectTrusted: false }), ["docs", "my-db"]);
    assert.deepEqual(await reader.configured({ agentDir: dir, cwd: path.join(dir, "project"), projectTrusted: true }), ["docs", "my-db", "docs", "local"]);
    assert.deepEqual(mod.countMcp([], await reader.configured({ agentDir: dir, cwd: path.join(dir, "project"), projectTrusted: true })), { connected: 0, total: 3 }, "a project override of a global server counts once");
    assert.deepEqual(await reader.configured({ agentDir: dir, cwd: path.join(dir, "elsewhere"), projectTrusted: true }), ["docs", "my-db"], "no project file is fine");
    const { utimes } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ mcpServers: { only: {} } }));
    await utimes(file, new Date(now), new Date(now));
    assert.deepEqual(await reader.read(file), ["only"]);
    await writeFile(file, JSON.stringify({ mcpServers: { changed: {} } }));
    await utimes(file, new Date(now), new Date(now));
    assert.deepEqual(await reader.read(file), ["only"], "an unchanged mtime serves the cached names");
    await utimes(file, new Date(now + 1000), new Date(now + 1000));
    assert.deepEqual(await reader.read(file), ["changed"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("MCP chip: built-in servers in the status row, yielding to a published mcp status, project trust and /status mcp", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-mcp-chip-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const project = path.join(dir, "project");
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: { docs: {}, "my-db": {}, off: { enabled: false } } }));
  await writeFile(path.join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { local: {} } }));
  const h = host([], project);
  const tool = (namespace, exposure = "codemode") => ({ namespace: { name: namespace }, sourceInfo: { path: "builtin:mcp" }, exposure });
  const statusRow = (width = 120) => h.footer.render(width).map(plain).find((row) => /MCP/.test(row)) ?? "";
  try {
    await h.handlers.get("session_start")({}, h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(statusRow(), "", "no /mcp command: pi's built-in MCP is not loaded");
    h.commandInfos.push({ name: "mcp", sourceInfo: { path: "builtin:mcp" } });
    await h.handlers.get("agent_settled")({}, h.ctx);
    await vi.waitFor(() => assert.match(statusRow(), /^ \uf1e6 MCP 0\/2$/), "configured but nothing connected yet");
    h.tools.push(tool("mcp__docs"), tool("mcp__docs", "direct"), tool("mcp__my_db"), tool("mcp__hidden", "hidden"));
    await h.handlers.get("mcp_servers_change")({}, h.ctx);
    await vi.waitFor(() => assert.match(statusRow(), /^ \uf1e6 MCP 2\/2$/));
    assert.equal(h.footer.render(120).filter((row) => /MCP/.test(row)).length, 1);
    for (let width = 1; width <= 240; width++) assert.ok(h.footer.render(width).every((row) => visibleWidth(row) <= width));
    h.trusted = true;
    await h.handlers.get("agent_settled")({}, h.ctx);
    await vi.waitFor(() => assert.match(statusRow(), /MCP 2\/3$/), "the trusted project's file adds its servers");
    h.statuses.set("plan", "PLAN mode");
    assert.match(statusRow(), /^ \uf1e6 MCP 2\/3 \u00b7 PLAN mode$/, "the chip leads the status row and shares its separator");
    h.statuses.set("mcp", "\u{1f50c} MCP: 5 connected");
    assert.equal(statusRow(), " \uf1e6 MCP: 5 connected \u00b7 PLAN mode", "another extension's mcp status replaces the chip");
    h.statuses.delete("mcp"); h.statuses.delete("plan");
    await h.commands.get("status").handler("mcp off", h.ctx);
    assert.equal(statusRow(), "");
    assert.match(h.notices.at(-1), /MCP chip disabled/);
    assert.deepEqual(h.entries.at(-1).data, { enabled: true, showAll: false, working: true, mcp: false });
    await h.handlers.get("session_shutdown")({}, h.ctx);
    await h.handlers.get("session_start")({}, h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(statusRow(), "", "the preference survives reload");
    await h.commands.get("status").handler("details", h.ctx);
    assert.match(h.notices.at(-1), /MCP chip: off/);
    await h.commands.get("status").handler("mcp on", h.ctx);
    await vi.waitFor(() => assert.match(statusRow(), /MCP 2\/3$/));
    h.commandInfos.push({ name: "mcp", sourceInfo: { path: "/elsewhere/pi-mcp-adapter.ts" } });
    await h.handlers.get("agent_settled")({}, h.ctx);
    await vi.waitFor(() => assert.equal(statusRow(), ""), "an extension that took over /mcp owns the chip");
  } finally {
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the MCP chip renders with the companion label style and warns on a shortfall", () => {
  const paint = { fg: (color, text) => `<${color}>${text}</${color}>`, bold: (text) => text };
  const rows = (mcp, statuses = []) => mod.renderFooter({ ...fixture(), mcp, statuses }, 120, paint).map((row) => row.trim());
  assert.ok(rows({ connected: 2, total: 2 }).includes("<dim>\uf1e6</dim> <muted>MCP</muted> 2/2"));
  assert.ok(rows({ connected: 1, total: 3 }).includes("<dim>\uf1e6</dim> <muted>MCP</muted> <warning>1/3</warning>"));
  assert.ok(rows({ connected: 1, total: 3 }, ["Gate off"]).includes("<dim>\uf1e6</dim> <muted>MCP</muted> <warning>1/3</warning><dim> \u00b7 </dim><dim>\uf510</dim> Gate off"));
  assert.ok(!rows(undefined).some((row) => /MCP/.test(row)));
  const withSkills = mod.renderFooter({ ...fixture(), mcp: { connected: 2, total: 2 }, skills: 7, statuses: ["Gate off"] }, 240, paint).map((row) => row.trim());
  assert.ok(withSkills.includes("<dim>\uf1e6</dim> <muted>MCP</muted> 2/2<dim> \u00b7 </dim><dim>\uf0d0</dim> <muted>Skills</muted> 7<dim> \u00b7 </dim><dim>\uf510</dim> Gate off"));
  assert.ok(mod.renderFooter({ ...fixture(), skills: 3 }, 120, paint).some((row) => row.trim() === "<dim>\uf0d0</dim> <muted>Skills</muted> 3"), "skills show without MCP");
  assert.ok(!mod.renderFooter({ ...fixture(), skills: 0 }, 120, paint).some((row) => /Skills/.test(row)));
  for (const name of ["light", "dark"]) {
    for (let width = 1; width <= 240; width++) {
      assert.ok(mod.renderFooter({ ...fixture(), mcp: { connected: 1, total: 3 }, statuses: ["Gate off"] }, width, getThemeByName(name)).every((row) => visibleWidth(row) <= width));
    }
  }
});

test("the permission mode gets its own row in its color; plan runs point at /planners", () => {
  const absorbed = mod.absorbStatuses(new Map([
    ["permission-mode", "⏵⏵ accept edits on (shift+tab to cycle)"],
    ["plan", "plan: A working · B cut off (resume in /planners) (/planners)"],
  ]), { claudeRow: false });
  assert.deepEqual(absorbed.mode, { kind: "acceptEdits", label: "\u{f0211} accept edits on", key: "shift+tab" });
  assert.deepEqual(absorbed.rest, ["Plan A working · B cut off · resume in /planners · /planners"]);
  const s = { ...fixture(), mode: absorbed.mode, statuses: absorbed.rest };
  const rows = mod.renderFooter(s, 160, theme).map(plain);
  assert.match(rows[1], /opus-5\.5 · \uee9c reasoning xhigh$/);
  assert.equal(rows[2], " \uf510 \u{f0211} accept edits on (shift+tab to cycle)");
  // Narrow: the hint goes before the mode does.
  assert.match(plain(mod.renderFooter(s, 30, theme)[2]), /\u{f0211} accept edits on$/u);
  // Outside auto mode the gate stays with the notices; in auto mode it follows the mode.
  const gated = { ...s, statuses: ["Gate 2 auto · 0 pushed back · 1 asked"] };
  assert.ok(!plain(mod.renderFooter(gated, 160, theme)[2]).includes("Gate"));
  const auto = { ...gated, mode: mod.parseModeStatus("⏵⏵ auto mode on (shift+tab to cycle)") };
  const autoRows = mod.renderFooter(auto, 160, theme).map(plain);
  assert.equal(autoRows[2], " \uf510 \u{f0211} auto mode on (shift+tab to cycle) · Gate 2 auto · 0 pushed back · 1 asked");
  assert.equal(autoRows.filter((r) => r.includes("Gate")).length, 1);
  assert.equal(mod.parseModeStatus("⏸ plan mode on").kind, "plan");
  assert.equal(mod.parseModeStatus("⏸ plan mode on").label, "\u{f03e4} plan mode on");
  assert.equal(visibleWidth(mod.ICONS.paused), visibleWidth(mod.ICONS.running));
  assert.equal(mod.parseModeStatus("⏸ chat mode on (shift+tab to cycle)").kind, "chat");
  assert.equal(mod.parseModeStatus("⏵⏵ yolo mode on (shift+tab to cycle)").kind, "bypass");
  assert.equal(mod.parseModeStatus("⏵⏵ bypass permissions on").kind, "bypass");
  assert.equal(mod.parseModeStatus("plan mode please"), undefined);
  assert.deepEqual(mod.absorbStatuses(new Map([["permission-mode", "something else"]]), { claudeRow: false }).rest, ["something else"]);
});

test("a waiting dialog compacts the footer to one row for herdr-web-ui", () => {
  const s = fixture();
  s.stash = { text: "draft" };
  s.statuses = ["Gate auto", "PLAN mode"];
  assert.ok(mod.renderFooter(s, 120, theme).length > 2);
  s.compact = true;
  for (const width of [30, 46, 120, 200]) {
    const rows = mod.renderFooter(s, width, theme);
    assert.equal(rows.length, 1, `width ${width}`);
  }
  const rows = mod.renderFooter(s, 120, theme).map(plain);
  assert.match(rows[0], /opus-5\.5/);
  assert.match(rows[0], /Context 28%/);
  assert.match(rows[0], /dotfiles|pi-plugins|project/);
});

test("parseMarimoStatus reads the server address", async () => {
  const mod = await import("../src/index.ts");
  assert.equal(mod.parseMarimoStatus("marimo: a.py · :2718 · 1 queued").where, ":2718");
  const remote = mod.parseMarimoStatus("marimo: a.py · nb.example.com/lab · disconnected");
  assert.equal(remote.where, "nb.example.com/lab");
  assert.deepEqual(remote.notes, ["disconnected"]);
});
