// Vega and Vega-Lite specs (Altair charts) drawn as PNGs for the notebook view. vl-convert has no
// browser to start: `uv run --with vl-convert-python` renders in a fraction of a second once cached,
// and the result is kept by spec so each chart renders once.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const SCRIPT = [
  "import sys, json, base64, vl_convert as v",
  "spec = json.load(sys.stdin)",
  "png = v.vegalite_to_png(spec, scale=2.0) if 'vega-lite' in str(spec.get('$schema', 'vega-lite')) else v.vega_to_png(spec, scale=2.0)",
  "sys.stdout.write(base64.b64encode(png).decode())",
].join("\n");

const TIMEOUT_MS = 30_000;
const MAX_PNG = 2_000_000;

/** Runs the converter: the spec on stdin, base64 PNG on stdout; rejects when it fails. */
export type VegaRunner = (spec: string) => Promise<string>;

export const uvRunner: VegaRunner = (spec) =>
  new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "--quiet", "--with", "vl-convert-python", "python", "-c", SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timed out")); }, TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { if (out.length <= MAX_PNG * 2) out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { if (err.length < 2_000) err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && /^[A-Za-z0-9+/]+=*$/u.test(out.trim())) resolve(out.trim());
      else reject(new Error(err.trim().split("\n").at(-1) || `exit ${code}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(spec);
  });

export type ChartState = { status: "rendering" } | { status: "ready"; png: string } | { status: "failed"; reason: string };

/** Renders each distinct spec once, remembering the outcome; `peek` reads it, `request` starts it. */
export class ChartRenderer {
  private readonly states = new Map<string, ChartState>();
  constructor(private readonly run: VegaRunner = uvRunner, private readonly max = 24) {}

  private key(spec: string): string {
    return createHash("sha1").update(spec).digest("hex");
  }

  peek(spec: string): ChartState | undefined {
    return this.states.get(this.key(spec));
  }

  /** Starts rendering unless it already has; `onDone` runs when it settles. */
  request(spec: string, onDone: () => void): ChartState {
    const key = this.key(spec);
    const known = this.states.get(key);
    if (known) return known;
    const state: ChartState = { status: "rendering" };
    this.states.set(key, state);
    if (this.states.size > this.max) this.states.delete(this.states.keys().next().value as string);
    this.run(spec).then(
      (png) => this.states.set(key, png.length <= MAX_PNG ? { status: "ready", png } : { status: "failed", reason: "image too large" }),
      (e: unknown) => this.states.set(key, { status: "failed", reason: e instanceof Error ? e.message : String(e) }),
    ).finally(onDone);
    return state;
  }
}

/** The Vega-Lite renderer; the Plotly one is the same class with another runner (plotly.ts). */
export { ChartRenderer as VegaRenderer };
