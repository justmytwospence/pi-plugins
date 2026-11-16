import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PNG } from "./harness.ts";
import { imageMimeType, saveClipboardImage } from "../src/clipboard.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "clip-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

test("imageMimeType reads magic bytes", () => {
  expect(imageMimeType(PNG)).toBe("image/png");
  expect(imageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(imageMimeType(new TextEncoder().encode("GIF89a.."))).toBe("image/gif");
  expect(imageMimeType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(imageMimeType(new TextEncoder().encode("hello"))).toBeUndefined();
});

test("saveClipboardImage writes pi-clipboard-<uuid>.png", () => {
  const dir = tmp();
  const saved = saveClipboardImage(PNG, dir)!;
  expect(saved.mimeType).toBe("image/png");
  expect(saved.path).toMatch(/pi-clipboard-[\w-]+\.png$/u);
  expect([...readFileSync(saved.path)]).toEqual([...PNG]);
});

test("saveClipboardImage refuses unknown bytes", () => {
  const dir = tmp();
  expect(saveClipboardImage(new TextEncoder().encode("garbage"), dir)).toBeUndefined();
  expect(readdirSync(dir)).toEqual([]);
  expect(existsSync(dir)).toBe(true);
});
