import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  theme as piTheme,
  setTerminalColors,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { EDAMAME_THEME, edamameConfigDir, edamameTheme, prepareEditor } from "../src/external-editor.js";

initTheme("dark");

test("edamame gets Pi's theme on the terminal's own background", () => {
  setTerminalColors({ background: { r: 30, g: 31, b: 32 }, foreground: { r: 200, g: 201, b: 202 } });
  try {
    const toml = edamameTheme(piTheme);
    assert.match(toml, /^light = false$/mu, "a dark Pi theme is a dark edamame theme");
    assert.match(toml, /^task_strikethrough = true$/mu);
    assert.match(toml, /^\[palette\]$/mu);
    assert.match(toml, /^bg = "#1e1f20"$/mu, "the terminal's own background, as a colour edamame can blend toward");
    for (const slot of ["text", "text_muted", "primary", "link", "code", "success", "warning", "error", "accent"]) {
      assert.match(toml, new RegExp(`^${slot} = "#[0-9a-f]{6}"$`, "mu"), `${slot} from Pi's theme`);
    }
    assert.match(toml, /^bg_muted = "#[0-9a-f]{6}"$/mu, "stripes mixed from the terminal's colours");
    assert.doesNotMatch(toml, /undefined/u);
    setTerminalColors({});
    assert.match(edamameTheme(piTheme), /^bg = "#1e1e1e"$/mu, "a dark fallback when the terminal never said");
  } finally {
    setTerminalColors({});
  }
});

test("only an edamame gets the theme, written where edamame reads it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edamame-config-"));
  const env = { XDG_CONFIG_HOME: dir };
  const file = path.join(dir, "edamame", "themes", `${EDAMAME_THEME}.toml`);
  try {
    assert.equal(edamameConfigDir(env), path.join(dir, "edamame"));
    assert.equal(edamameConfigDir({ XDG_CONFIG_HOME: "relative" }), path.join(os.homedir(), ".config", "edamame"));
    prepareEditor("vim", piTheme, env);
    assert.equal(fs.existsSync(file), false, "another editor is left alone");
    prepareEditor("/opt/homebrew/bin/edamame --flag", piTheme, env);
    assert.equal(fs.readFileSync(file, "utf8"), edamameTheme(piTheme));
    prepareEditor("edamame", undefined, env);
    assert.ok(fs.existsSync(file), "without a theme, the last one stays");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
