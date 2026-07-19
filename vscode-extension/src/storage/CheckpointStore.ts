import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sha256Hex } from "../capture/hash";
import type { CheckpointMeta } from "../model/events";
import { atomicWriteFile } from "./atomicFile";

// Checkpoint bodies are exact UTF-8 text files, written atomically BEFORE
// the checkpoint event is journaled (plan §9.4).
export class CheckpointStore {
  constructor(private readonly dir: string) {}

  fileFor(checkpointId: string): string {
    // IDs are extension-generated UUIDs/fixture slugs; keep a hard guard
    // against path separators anyway.
    if (!/^[A-Za-z0-9._-]+$/.test(checkpointId)) {
      throw new Error(`invalid checkpoint id: ${checkpointId}`);
    }
    return path.join(this.dir, `${checkpointId}.txt`);
  }

  async write(meta: CheckpointMeta, text: string): Promise<void> {
    const actual = sha256Hex(text);
    if (meta.sha256 !== actual) {
      throw new Error(
        `checkpoint ${meta.checkpointId} hash mismatch: meta ${meta.sha256} vs text ${actual}`,
      );
    }
    await atomicWriteFile(this.fileFor(meta.checkpointId), text);
  }

  async read(checkpointId: string): Promise<string> {
    return fs.readFile(this.fileFor(checkpointId), "utf8");
  }

  /** Read and verify against recorded metadata (plan §13.2). */
  async readVerified(meta: CheckpointMeta): Promise<string> {
    const text = await this.read(meta.checkpointId);
    const actual = sha256Hex(text);
    if (actual !== meta.sha256) {
      throw new Error(
        `checkpoint ${meta.checkpointId} corrupted: expected ${meta.sha256}, got ${actual}`,
      );
    }
    return text;
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir);
      return entries
        .filter((name) => name.endsWith(".txt"))
        .map((name) => name.slice(0, -".txt".length));
    } catch {
      return [];
    }
  }
}
