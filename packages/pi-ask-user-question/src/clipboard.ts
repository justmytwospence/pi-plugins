// Reading the system clipboard for the answer fields: copied files, an image, or text, in the
// order Pi's own prompt tries them. An image is saved to a temporary file whose path is inserted.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNativeClipboard } from "@earendil-works/pi-tui";

export type ClipboardContent =
  | { kind: "files"; paths: string[] }
  | { kind: "image"; bytes: Uint8Array }
  | { kind: "text"; text: string }
  | undefined;
export type ClipboardReader = () => Promise<ClipboardContent>;

/** Rejects when no clipboard is reachable or a transfer fails; resolves undefined when it is empty. */
export const readClipboard: ClipboardReader = async () => {
  const cb = getNativeClipboard();
  if (!cb) throw new Error("no clipboard access in this terminal");
  const paths = await cb.getFilePaths?.();
  if (paths?.length) return { kind: "files", paths };
  const bytes = await cb.getImage();
  if (bytes?.length) return { kind: "image", bytes };
  const text = await cb.getText();
  if (text) return { kind: "text", text };
  return undefined;
};

type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const startsWith = (bytes: Uint8Array, at: number, sig: readonly number[]) => sig.every((b, i) => bytes[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function imageMimeType(bytes: Uint8Array): ImageMime | undefined {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, 0, ascii("GIF87a")) || startsWith(bytes, 0, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, 0, ascii("RIFF")) && startsWith(bytes, 8, ascii("WEBP"))) return "image/webp";
  return undefined;
}

const EXTENSIONS: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export function saveClipboardImage(bytes: Uint8Array, dir: string = tmpdir()): { path: string; mimeType: string } | undefined {
  const mimeType = imageMimeType(bytes);
  if (!mimeType) return undefined;
  const path = join(dir, `pi-clipboard-${randomUUID()}.${EXTENSIONS[mimeType]}`);
  writeFileSync(path, bytes);
  return { path, mimeType };
}
