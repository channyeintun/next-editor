import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ARTIFACT_EXTENSION } from "../model/ids";
import { SessionPaths } from "./SessionPaths";

export type LibraryEntry = {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  modifiedAt: Date;
};

// Canonical finalized artifacts live in extension-local storage
// (plan §9.7); Export copies them to user-chosen destinations.
export class RecordingLibrary {
  constructor(private readonly storageRoot: string) {}

  get recordingsDir(): string {
    return SessionPaths.recordingsRoot(this.storageRoot);
  }

  artifactPathFor(sessionId: string, finalizedAt: Date): string {
    const stamp = finalizedAt.toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const shortId = sessionId.slice(0, 8);
    return path.join(this.recordingsDir, `recording-${stamp}-${shortId}${ARTIFACT_EXTENSION}`);
  }

  async list(): Promise<LibraryEntry[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.recordingsDir);
    } catch {
      return [];
    }
    const out: LibraryEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(ARTIFACT_EXTENSION)) {
        continue;
      }
      const filePath = path.join(this.recordingsDir, name);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat?.isFile()) {
        out.push({
          fileName: name,
          filePath,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime,
        });
      }
    }
    out.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    return out;
  }
}
