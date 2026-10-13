import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { plugins } from "../src/data/plugins.mjs";

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
if (names.length !== 26) fail("Expected 26 suite entries; update the public count deliberately when the manifest changes.");
if (new Set(catalog).size !== catalog.length) fail("Duplicate plugin in catalog.");
if (JSON.stringify(names) !== JSON.stringify(catalog)) fail("Catalog does not match the root suite manifest.");

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
    if ((body.match(/^## /gm) || []).length < 4) fail(relative + ": reference needs useful sections.");
    if (body.split(/\s+/).length < 180) fail(relative + ": reference is too thin.");
    if (!/requirements|dependencies|costs/i.test(body)) fail(relative + ": spell out requirements/costs.");
    if (!body.includes("https://github.com/justmytwospence/pi-plugins/")) fail(relative + ": missing suite source link.");
  } else if (file.includes(path.sep + "plugins" + path.sep)) fail(relative + ": missing plugin frontmatter.");

  if (/\p{Extended_Pictographic}/u.test(body)) fail(relative + ": do not use emojis.");
  for (const install of body.matchAll(/pi install\s+git:github\.com\/justmytwospence\/(pi-[\w-]+)/g)) {
    if (install[1] !== "pi-plugins") fail(relative + ": retired component install source " + install[1]);
  }
  if (/all 19 (?:extensions|entries)|default is Shift\+Tab/i.test(body)) fail(relative + ": stale suite count or plan shortcut claim.");
  if (data.plugin === "pi-diff-review" && /:mark[^\n]*and closes|:mark[^\n]*and close/i.test(body)) fail(relative + ": explicit marking must stay open.");
  for (const block of body.matchAll(/^```json[^\n]*\n([\s\S]*?)^```/gm)) {
    try {
      const value = JSON.parse(block[1]);
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
else console.log("PASS: " + paths.length + " authored pages; all " + covered.size + " suite references covered; frontmatter, JSON examples, selected entries and source links checked. Rendered fragments are checked by npm run build.");
