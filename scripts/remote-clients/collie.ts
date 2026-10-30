// Collie's own pi reader over the rendered screens (../test-remote-clients.mjs), as the phone reads
// this machine's panes: with the frame declaration in frames.toml. Run with bun from the checkout's
// `web/`: `bun collie.ts <screens.json> <collie checkout> <frames.toml>`. Prints the blocks per screen,
// and the editor frame Collie finds (its composer state and the draft it reads).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const [screensFile, checkout, framesFile] = process.argv.slice(2) as [string, string, string];
const lib = path.join(checkout, "web/src/lib");
const { parseAnsi } = await import(path.join(lib, "ansi.ts"));
const { splitLines } = await import(path.join(lib, "blocks.ts"));
const { buildBlocks } = await import(path.join(lib, "harness/index.ts"));
const { frameDeclarationsFrom } = await import(path.join(lib, "frame-declarations.ts"));
const { declareFrames, requireProfile } = await import(path.join(lib, "surface/profile.ts"));
const { surfaceOfScreen } = await import(path.join(lib, "surface/fold.ts"));
const frames = existsSync(framesFile) ? frameDeclarationsFrom(Bun.TOML.parse(readFileSync(framesFile, "utf8")), "toml") : undefined;
declareFrames(frames);
const idle = requireProfile("pi").idle ?? null;
const screens: { ansi: string }[] = JSON.parse(readFileSync(screensFile, "utf8"));
type Line = { segments: { text: string }[] };
const lineText = (line: Line) => line.segments.map((segment) => segment.text).join("");
const out = screens.map(({ ansi }) => {
  const rows = splitLines(parseAnsi(ansi));
  const originalTexts = rows.map(lineText);
  const blocks = buildBlocks(rows, { agent: "pi", frames });
  // The editor Collie finds (what lets a phone send type), and the draft it reads in it.
  const read = surfaceOfScreen({ revision: 0, rows }, idle);
  return {
    composer: read.surface.composer,
    draft: read.frame?.interior.text ?? null,
    blocks: blocks.map((b: {
      kind: string;
      prompt?: { question: string; options: { label: string }[] };
      lines?: Line[];
      cancel?: { key: string; agent: string; signature: string };
    }) => {
      if (b.kind === "prompt-select") return { kind: b.kind, question: b.prompt!.question, options: b.prompt!.options.map((o) => o.label) };
      if (b.kind === "unread-dialog") return {
        kind: b.kind,
        cancel: b.cancel,
        wholePane: b.lines?.length === originalTexts.length && b.lines.every((line, i) => lineText(line) === originalTexts[i]),
      };
      return { kind: b.kind };
    }),
  };
});
console.log(JSON.stringify(out));
