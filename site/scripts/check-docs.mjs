import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { plugins } from "../src/data/plugins.mjs";
import { keymapSdkVersion, stockBindings, suiteShortcuts } from "../src/data/keymap.mjs";

const site = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(site, "..");
const docs = path.join(site, "src/content/docs");
const errors = [];
const fail = (message) => errors.push(message);
async function filesIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : path.join(dir, entry.name)))).flat();
}
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const entries = manifest.pi.extensions.map((entry) => entry.replace(/^\.\//, ""));
const names = entries.map((entry) => entry.split("/")[1]).sort();
const catalog = plugins.map((plugin) => plugin.name).sort();
if (names.length !== 34) fail("Expected 34 suite entries; update the public count deliberately when the manifest changes.");
if (new Set(catalog).size !== catalog.length) fail("Duplicate plugin in catalog.");
if (JSON.stringify(names) !== JSON.stringify(catalog)) fail("Catalog does not match the root suite manifest.");
if (manifest.devDependencies?.["@earendil-works/pi-coding-agent"] !== keymapSdkVersion) fail("Re-audit the keymap baseline when the configured Pi SDK test target changes.");

// The README is the linked front door, not a second unlinked plugin inventory.
const readme = await readFile(path.join(root, "README.md"), "utf8");
const readmeCatalog = [...readme.matchAll(/\| \[(pi-[\w-]+)\]\(https:\/\/pi-plugins\.vercel\.app\/plugins\/(pi-[\w-]+)\/\)/g)];
for (const match of readmeCatalog) if (match[1] !== match[2]) fail("README catalog label/URL mismatch: " + match[1]);
const readmeNames = readmeCatalog.map((match) => match[1]).sort();
if (JSON.stringify(readmeNames) !== JSON.stringify(names)) fail("README needs one linked catalog row for each suite entry.");
for (const route of ["guides/keyboard", "guides/requirements", "development"]) {
  if (!readme.includes("https://pi-plugins.vercel.app/" + route + "/")) fail("README is missing a prominent " + route + " link.");
}

const knownActions = new Set(Object.keys(stockBindings));
const normalizeKey = (key) => key.toLowerCase().split("+").sort().join("+");
const normalizeKeys = (keys) => (Array.isArray(keys) ? keys : [keys]).map(normalizeKey).sort();
const keyboard = await readFile(path.join(docs, "guides/keyboard.md"), "utf8");
const stockRows = [...keyboard.matchAll(/^\| `((?:app|tui)\.[\w.]+)` \| ([^|]+) \|/gm)];
const requiredKeymapActions = [
  ...Object.keys(stockBindings).filter((action) => action.startsWith("tui.altScreen.")),
  "tui.editor.historyPrevious", "tui.editor.historyNext", "tui.editor.deleteToLineStart",
  "tui.editor.deleteToLineEnd", "tui.editor.deleteCharForward", "tui.input.newLine",
  "tui.input.submit", "app.editor.external", "app.model.select", "app.thinking.cycle", "app.thinking.toggle",
  ...Object.keys(stockBindings).filter((action) => action.startsWith("tui.select.")),
];
for (const action of requiredKeymapActions) {
  if (!stockRows.some((row) => row[1] === action)) fail("Missing task-critical stock keymap row: " + action);
}
const seenActions = new Set();
for (const [, action, displayed] of stockRows) {
  if (seenActions.has(action)) fail("Duplicate stock keymap row: " + action);
  seenActions.add(action);
  if (!knownActions.has(action)) { fail("Unknown stock keymap action: " + action); continue; }
  const keys = displayed.trim() === "Unbound" ? [] : displayed.trim().split(" / ");
  if (JSON.stringify(normalizeKeys(keys)) !== JSON.stringify(normalizeKeys(stockBindings[action]))) {
    fail("Wrong stock default for " + action + ": " + displayed.trim());
  }
}
// Plugin settings are not invented app/tui action IDs. Keep their suite defaults explicit.
const suiteRows = [...keyboard.matchAll(/^\| `(pi-[\w-]+)` \| ([^|]+) \|/gm)];
for (const [name, shortcut] of Object.entries(suiteShortcuts)) {
  const row = suiteRows.find((row) => row[1] === name);
  if (!names.includes(name)) fail("Unknown suite shortcut owner: " + name);
  if (!row || normalizeKey(row[2].trim()) !== normalizeKey(shortcut.defaultKey)) {
    fail("Missing or wrong suite shortcut default for " + name + "." + shortcut.setting);
  }
}
const profileSection = keyboard.split("## Optional personal profile")[1] ?? "";
const profileBlock = profileSection.match(/^```json\n([\s\S]*?)^```/m);
const todoProfileBlock = profileSection.split("### Optional todo rebind")[1]?.match(/^```json\n([\s\S]*?)^```/m);
try {
  const profile = JSON.parse(profileBlock?.[1] ?? "null");
  if (!profile || JSON.stringify(profile["app.editor.external"]) !== "[]" ||
      JSON.stringify(profile["tui.altScreen.bottom"]) !== '["ctrl+g","ctrl+end"]') {
    fail("Labeled personal profile must separate external-editor chord from Ctrl+G transcript tail.");
  }
  const todoProfile = JSON.parse(todoProfileBlock?.[1] ?? "null");
  if (todoProfile?.collapseKey !== "ctrl+t" || profile?.["app.thinking.toggle"] !== "ctrl+shift+t") {
    fail("Optional personal todo rebind must pair Ctrl+T with explicitly relocated native thinking.");
  }
} catch { fail("Invalid optional personal keymap or todo profile."); }

const paths = (await filesIn(docs)).filter((file) => /\.mdx?$/.test(file));
const routeFor = (file) => "/" + path.relative(docs, file).replaceAll(path.sep, "/").replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "") .replace(/\/$/, "") + "/";
const normalizedRoute = (route) => route.replace(/\/+/g, "/");
const routes = new Set(paths.map((file) => normalizedRoute(routeFor(file))));
const covered = new Set();

for (const file of paths) {
  const relative = path.relative(site, file);
  const raw = await readFile(file, "utf8");
  const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!front) { fail(relative + ": missing frontmatter."); continue; }
  let data;
  try { data = parse(front[1]); } catch (error) { fail(relative + ": invalid YAML: " + error.message); continue; }
  if (!data?.title || typeof data.title !== "string") fail(relative + ": missing title.");
  if (!data?.description || typeof data.description !== "string" || data.description.length < 30) fail(relative + ": missing useful description.");
  const body = raw.slice(front[0].length);
  if (data.plugin) {
    if (!names.includes(data.plugin)) fail(relative + ": unknown plugin " + data.plugin);
    if (covered.has(data.plugin)) fail(relative + ": duplicate plugin reference.");
    covered.add(data.plugin);
    if (path.basename(file, path.extname(file)) !== data.plugin) fail(relative + ": filename must match plugin.");
    const entry = entries.find((candidate) => candidate.split("/")[1] === data.plugin);
    if (entry && !body.includes(entry)) fail(relative + ": missing exact selection entry " + entry + ".");
    const quick = body.match(/^## Quick reference\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? "";
    for (const label of ["Use it for", "Enable", "Controls", "Settings", "Requirements, cost & privacy", "Integrations & limits"]) {
      if (!quick.includes("- **" + label + ":** ")) fail(relative + ": missing Quick reference field " + label + ".");
    }
    if (entry && !quick.includes(entry)) fail(relative + ": Quick reference needs the exact selection entry.");
    // No arbitrary word-count floor: small automatic plugins should state their boundaries,
    // not pad a page or invent commands/shortcuts to satisfy a minimum.
    if (!body.includes("https://github.com/justmytwospence/pi-plugins/")) fail(relative + ": missing suite source link.");
  } else if (file.includes(path.sep + "plugins" + path.sep)) fail(relative + ": missing plugin frontmatter.");

  if (/\p{Extended_Pictographic}/u.test(body)) fail(relative + ": do not use emojis.");
  for (const match of body.matchAll(/`((?:app|tui)\.[\w.]+)`/g)) {
    if (!knownActions.has(match[1])) fail(relative + ": unknown Pi action ID " + match[1]);
  }
  for (const install of body.matchAll(/pi install\s+git:github\.com\/justmytwospence\/(pi-[\w-]+)/g)) {
    if (install[1] !== "pi-plugins") fail(relative + ": retired component install source " + install[1]);
  }
  if (/all 19 (?:extensions|entries)|default is Shift\+Tab/i.test(body)) fail(relative + ": stale suite count or plan shortcut claim.");
  if (data.plugin === "pi-diff-review" && /:mark[^\n]*and closes|:mark[^\n]*and close/i.test(body)) fail(relative + ": explicit marking must stay open.");
  for (const block of body.matchAll(/^```json[^\n]*\n([\s\S]*?)^```/gm)) {
    try {
      const value = JSON.parse(block[1]);
      for (const action of Object.keys(value)) {
        if (/^(?:app|tui)\./.test(action) && !knownActions.has(action)) fail(relative + ": unknown JSON keybinding action " + action);
      }
      for (const pkg of value.packages || []) {
        if (typeof pkg === "object") for (const entry of pkg.extensions || []) {
          if (entry.startsWith("./packages/")) fail(relative + ": selection paths must not start with ./");
          if (entry.startsWith("packages/") && !entries.includes(entry)) fail(relative + ": unknown selected entry " + entry);
        }
      }
    } catch (error) { fail(relative + ": invalid JSON example: " + error.message); }
  }

  // Fenced examples are not navigational links.
  const prose = body.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
  for (const match of prose.matchAll(/\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    const source = href.match(/^https:\/\/github\.com\/justmytwospence\/pi-plugins\/(?:blob|tree)\/main\/([^#?]+)/);
    if (source) {
      try { await access(path.join(root, decodeURIComponent(source[1]))); }
      catch { fail(relative + ": missing repository source target " + href); }
    }
    if (href.startsWith("#") || /^(https?:|mailto:)/.test(href)) continue;
    const url = new URL(href, "https://pi-plugins.vercel.app" + normalizedRoute(routeFor(file)));
    const route = normalizedRoute(url.pathname.endsWith("/") ? url.pathname : url.pathname + "/");
    if (!routes.has(route)) {
      try { await access(path.join(site, "public", decodeURIComponent(url.pathname))); }
      catch { fail(relative + ": broken local link " + href); }
    }
  }
}
for (const name of names) if (!covered.has(name)) fail("Missing reference for " + name);
for (const required of ["/", "/guides/overview/", "/guides/install/", "/guides/releases/", "/guides/requirements/", "/guides/keyboard/", "/guides/standalone/", "/guides/external/", "/guides/troubleshooting/", "/recipes/background-work/", "/recipes/notebooks/", "/recipes/plan-review/", "/recipes/cache-cost/", "/architecture/activity/", "/development/", "/about/"]) {
  if (!routes.has(required)) fail("Missing required page: " + required);
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log("PASS: " + paths.length + " authored pages; all " + covered.size + " suite references covered; uniform quick references, README catalog, audited stock/suite keymap defaults and optional profile separation, frontmatter, JSON examples, selected entries and source links checked. Rendered fragments are checked by npm run build.");
