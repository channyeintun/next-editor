import { createHash } from "node:crypto";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
