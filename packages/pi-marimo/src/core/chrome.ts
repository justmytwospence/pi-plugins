// The sandboxed headless Chrome the live charts run in: Chrome for Testing in pi-marimo's own cache,
// a throwaway profile, one page per chart. Never the Chrome you use. The browser and the plotly.js
// bundle come from `uv run --with plotly --with kaleido` once (kaleido downloads Chrome for Testing,
// plotly ships its bundle) and their paths are remembered.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type CdpClient, connectCdp } from "./cdp.js";

export interface Assets {
  chrome: string;
  plotlyJs: string;
}

const cacheDir = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-marimo");

const SETUP = String.raw`
import json, os, sys, plotly, kaleido
dest = os.environ.get("PI_MARIMO_CHROME_DIR") or sys.argv[1]
chrome = os.environ.get("BROWSER_PATH") or str(kaleido.get_chrome_sync(path=dest))
js = os.path.join(os.path.dirname(plotly.__file__), "package_data", "plotly.min.js")
print(json.dumps({"chrome": chrome, "plotlyJs": js}))
`;

/** Where the browser and plotly.js are; downloads the browser on first use (about 320 MB). */
export function resolveAssets(dir = cacheDir()): Promise<Assets> {
  const memo = join(dir, "assets.json");
  try {
    const known = JSON.parse(readFileSync(memo, "utf8")) as Assets;
    if (existsSync(known.chrome) && existsSync(known.plotlyJs)) return Promise.resolve(known);
  } catch { /* not resolved yet */ }
  return new Promise((resolve, reject) => {
    execFile("uv", ["run", "--quiet", "--with", "plotly", "--with", "kaleido", "python", "-c", SETUP, join(dir, "chrome")], { timeout: 300_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr).trim().split("\n").at(-1) || err.message));
      try {
        const found = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Assets;
        mkdirSync(dir, { recursive: true });
        writeFileSync(memo, JSON.stringify(found));
        resolve(found);
      } catch { reject(new Error("could not find the browser")); }
    });
  });
}

/** The page every chart loads: plotly.js, and `window.show(figure, width, height)`. */
export const hostHtml = (plotlyJs: string): string => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#fff;overflow:hidden}</style>
<div id="g"></div>
<script src="file://${plotlyJs}"></script>
<script>
window.__cur = (x, y) => {
  let c = document.getElementById("cur");
  if (!c) {
    c = document.createElement("div");
    c.id = "cur";
    c.style.cssText = "position:fixed;pointer-events:none;width:14px;height:14px;margin:-7px 0 0 -7px;border:2px solid #e8590c;border-radius:50%;box-shadow:0 0 0 1px #fff;z-index:99999";
    document.body.appendChild(c);
  }
  if (x === null) c.style.display = "none";
  else { c.style.display = "block"; c.style.left = x + "px"; c.style.top = y + "px"; }
};
window.show = async (fig, w, h) => {
  const el = document.getElementById("g");
  const layout = Object.assign({}, fig.layout || {}, { width: w, height: h, autosize: false });
  await Plotly.newPlot(el, fig.data || [], layout, Object.assign({ displayModeBar: "hover", scrollZoom: true }, fig.config || {}));
  return true;
};
</script>`;

/** One running browser. Pages are cheap; the browser itself ends when the host stops. */
export class ChromeHost {
  private child: ChildProcess | undefined;
  private client: Promise<CdpClient> | undefined;
  private profile: string | undefined;
  hostUrl = "";

  constructor(private readonly assets: () => Promise<Assets> = () => resolveAssets()) {}

  /** The DevTools client, starting the browser when needed. */
  connection(): Promise<CdpClient> {
    this.client ??= this.launch().catch((e) => { this.client = undefined; throw e; });
    return this.client;
  }

  private async launch(): Promise<CdpClient> {
    const { chrome, plotlyJs } = await this.assets();
    const dir = join(cacheDir(), "host");
    mkdirSync(dir, { recursive: true });
    const page = join(dir, "chart.html");
    writeFileSync(page, hostHtml(plotlyJs));
    this.hostUrl = `file://${page}`;
    this.profile = await mkdtemp(join(tmpdir(), "pi-marimo-chrome-"));
    const child = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${this.profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-extensions", "--mute-audio", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
    this.child = child;
    child.on("exit", () => { this.client = undefined; this.child = undefined; });
    const port = join(this.profile, "DevToolsActivePort");
    let url = "";
    for (let i = 0; i < 100 && !url; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const [p, path] = (await readFile(port, "utf8")).split("\n");
        if (p && path) url = `ws://127.0.0.1:${p}${path}`;
      } catch { /* not up yet */ }
      if (!this.child) throw new Error("the browser exited");
    }
    if (!url) throw new Error("the browser did not start");
    const client = await connectCdp(url);
    client.closed.then(() => this.stop());
    return client;
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.client = undefined;
    child?.kill("SIGKILL");
    const profile = this.profile;
    this.profile = undefined;
    if (profile) void rm(profile, { recursive: true, force: true });
  }
}

let shared: ChromeHost | undefined;
/** The one browser every view shares, started on first use and ended with Pi. */
export function sharedChrome(): ChromeHost {
  if (!shared) {
    shared = new ChromeHost();
    process.once("exit", () => shared?.stop());
  }
  return shared;
}

/** Ends the shared browser (the session ends or the extension reloads: a reload loads a fresh copy of this module). */
export function stopSharedChrome(): void {
  shared?.stop();
  shared = undefined;
}
