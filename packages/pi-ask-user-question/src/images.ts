// Pasted images as tool-result image blocks, resized as Pi's read tool does.
import { readFileSync } from "node:fs";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { imageMimeType } from "./clipboard.ts";
import type { ImageBlock } from "./result.ts";

export type Resize = typeof resizeImage;

export async function imageBlocks(
  paths: readonly string[],
  model: { input?: readonly string[] } | undefined,
  resize: Resize = resizeImage,
): Promise<Array<{ path: string; block: ImageBlock }>> {
  if (!model?.input?.includes("image")) return [];
  const out: Array<{ path: string; block: ImageBlock }> = [];
  for (const path of paths) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      continue;
    }
    const mime = imageMimeType(bytes);
    if (!mime) continue;
    const r = await resize(bytes, mime).catch(() => null);
    if (!r) continue;
    out.push({ path, block: { type: "image", data: r.data, mimeType: r.mimeType } });
  }
  return out;
}
