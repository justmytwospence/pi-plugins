import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { imageBlocks, type Resize } from "../src/images.ts";
import { PNG } from "./harness.ts";

const dir = mkdtempSync(join(tmpdir(), "img-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const png = join(dir, "a.png");
const text = join(dir, "b.txt");
writeFileSync(png, PNG);
writeFileSync(text, "hello");
const ok: Resize = async () => ({ data: "QQ==", mimeType: "image/png", originalWidth: 1, originalHeight: 1, width: 1, height: 1, wasResized: false });
const vision = { input: ["text", "image"] };

test("nothing is attached for a model without image input", async () => {
  expect(await imageBlocks([png], { input: ["text"] }, ok)).toEqual([]);
  expect(await imageBlocks([png], undefined, ok)).toEqual([]);
});

test("a PNG becomes an image block", async () => {
  expect(await imageBlocks([png], vision, ok)).toEqual([{ path: png, block: { type: "image", data: "QQ==", mimeType: "image/png" } }]);
});

test("missing, non-image and unresizable files are skipped", async () => {
  expect(await imageBlocks([join(dir, "nope.png"), text], vision, ok)).toEqual([]);
  expect(await imageBlocks([png], vision, async () => null)).toEqual([]);
});
