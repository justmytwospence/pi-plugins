import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const origin = "https://pi-plugins.vercel.app";
const errors = [];
// Astro redirect stubs (<meta http-equiv="refresh">) that are expected, by route, with their target.
const redirects = new Map([["/plugins/pi-marimo/", "https://github.com/justmytwospence/pi-marimo"]]);
async function walk(dir) {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : path.join(dir, entry.name)))).flat();
}
const files = await walk(dist);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
const pages = new Map();
for (const file of htmlFiles) {
  const relative = path.relative(dist, file).replaceAll(path.sep, "/");
  const route = relative === "index.html" ? "/" : "/" + relative.replace(/index\.html$/, "");
  const $ = load(await readFile(file, "utf8"));
  pages.set(route, { $, file, ids: new Set($("[id]").map((_, element) => $(element).attr("id")).get()) });
}
const home = pages.get("/")?.$;
if (!home || !home(".pp-hero").length || !home(".pp-install code").first().text().includes("pi install git:github.com/justmytwospence/pi-plugins")) {
  errors.push("Landing page must render the custom hero and real suite install command.");
}
let links = 0;
for (const [route, target] of redirects) {
  const page = pages.get(route);
  if (!page) errors.push(route + ": expected redirect stub is missing.");
  else if (!page.$('meta[http-equiv="refresh"]').attr("content")?.includes(target)) errors.push(route + ": redirect stub does not point to " + target);
}
for (const [route, { $ }] of pages) {
  if ($('meta[http-equiv="refresh"]').length) {
    if (!redirects.has(route)) errors.push(route + ": unexpected redirect page.");
    continue;
  }
  if ($("h1").length !== 1) errors.push(route + ": expected one h1.");
  if (!$("title").text().includes("Pi Plugins")) errors.push(route + ": missing branded title.");
  if (!($('meta[name="description"]').attr("content") || "").trim()) errors.push(route + ": missing description.");
  const canonical = $('link[rel="canonical"]').attr("href");
  if (route !== "/404.html" && canonical !== origin + route) errors.push(route + ": canonical is " + canonical);
  if (!$("html").attr("lang")) errors.push(route + ": missing document language.");
  for (const image of $("img").toArray()) if ($(image).attr("alt") === undefined) errors.push(route + ": image missing alt.");
  for (const element of $("a[href], img[src], script[src], link[rel=stylesheet][href]").toArray()) {
    const href = $(element).attr("href") || $(element).attr("src");
    if (!href || /^(mailto:|tel:|data:)/.test(href)) continue;
    let url;
    try { url = new URL(href, origin + route); } catch { errors.push(route + ": invalid URL " + href); continue; }
    if (url.origin !== origin) continue;
    links++;
    const pathname = decodeURIComponent(url.pathname);
    const target = pages.get(pathname) || pages.get(pathname.replace(/\/$/, "") + "/");
    if (target) {
      if (url.hash && !target.ids.has(decodeURIComponent(url.hash.slice(1)))) errors.push(route + ": missing fragment " + href);
    } else {
      const asset = path.resolve(dist, "." + pathname);
      if (!asset.startsWith(dist)) { errors.push(route + ": path leaves dist: " + href); continue; }
      try { await access(asset); } catch { errors.push(route + ": missing local target " + href); }
    }
  }
}
for (const asset of ["pagefind/pagefind.js", "sitemap-index.xml", "robots.txt", "favicon.svg", "social.svg"]) {
  try { await access(path.join(dist, asset)); } catch { errors.push("Missing build asset: " + asset); }
}
if (htmlFiles.length < 40) errors.push("Expected at least 39 authored pages and a 404 page.");
if (files.some((file) => /(?:^|\/)(?:\.env|auth\.json)$/.test(file))) errors.push("Unexpected credential file in build.");
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log("PASS: " + htmlFiles.length + " static HTML pages; " + links + " local links/assets; fragments, canonical URLs, metadata and search index.");
