// Collie's own pi reader over the rendered screens (../test-remote-clients.mjs), as the phone reads
// this machine's panes: with the frame declaration in frames.toml. Run with bun from the checkout's
// `web/`: `bun collie.ts <screens.json> <collie checkout> <frames.toml>`. Prints the blocks per screen.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const [screensFile, checkout, framesFile] = process.argv.slice(2) as [string, string, string];
const lib = path.join(checkout, "web/src/lib");
const { parseAnsi } = await import(path.join(lib, "ansi.ts"));
const { splitLines } = await import(path.join(lib, "blocks.ts"));
const { buildBlocks } = await import(path.join(lib, "harness/index.ts"));
const { frameDeclarationsFrom } = await import(path.join(lib, "frame-declarations.ts"));
const frames = existsSync(framesFile) ? frameDeclarationsFrom(Bun.TOML.parse(readFileSync(framesFile, "utf8")), "toml") : undefined;
const screens: { ansi: string }[] = JSON.parse(readFileSync(screensFile, "utf8"));
const out = screens.map(({ ansi }) => {
  const blocks = buildBlocks(splitLines(parseAnsi(ansi)), { agent: "pi", frames });
  return {
    blocks: blocks.map((b: { kind: string; prompt?: { question: string; options: { label: string }[] } }) =>
      b.kind === "prompt-select" ? { kind: b.kind, question: b.prompt!.question, options: b.prompt!.options.map((o) => o.label) } : { kind: b.kind },
    ),
  };
});
console.log(JSON.stringify(out));
