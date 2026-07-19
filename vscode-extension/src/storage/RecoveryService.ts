import * as fs from "node:fs/promises";
import type { SessionEvent } from "../model/events";
import { validateSessionEventRaw } from "../model/schemas";
import { readJournal, type JournalReadResult } from "./JournalReader";
import { SessionMetadataStore, type SessionMetadata } from "./SessionMetadataStore";
import { SessionPaths } from "./SessionPaths";

export type RecoverableSession = {
  sessionId: string;
  paths: SessionPaths;
  metadata: SessionMetadata | null;
  /** States that need user attention (plan §9.8). */
  recoverable: boolean;
};

export type SessionInspection = {
  metadata: SessionMetadata | null;
  journal: JournalReadResult;
  lastEvent: SessionEvent | null;
};

// Activation-time discovery of non-final sessions. Scans only the
// extension's own session directory (plan §9.8).
export class RecoveryService {
  constructor(private readonly storageRoot: string) {}

  async scan(): Promise<RecoverableSession[]> {
    const root = SessionPaths.sessionsRoot(this.storageRoot);
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      return [];
    }
    const out: RecoverableSession[] = [];
    for (const sessionId of entries) {
      const paths = new SessionPaths(this.storageRoot, sessionId);
      const stat = await fs.stat(paths.sessionDir).catch(() => null);
      if (!stat?.isDirectory()) {
        continue;
      }
      const metadata = await SessionMetadataStore.read(paths);
      const state = metadata?.state ?? null;
      const recoverable =
        state === null ||
        state === "preparing" ||
        state === "recording" ||
        state === "stopping" ||
        state === "finalizing" ||
        state === "failed";
      out.push({ sessionId, paths, metadata, recoverable });
    }
    return out;
  }

  async inspect(paths: SessionPaths): Promise<SessionInspection> {
    const metadata = await SessionMetadataStore.read(paths);
    let journal: JournalReadResult;
    try {
      journal = await readJournal(paths.journalFile, validateSessionEventRaw);
    } catch {
      journal = {
        events: [],
        byteOffsets: [],
        truncatedTailBytes: 0,
        corruption: null,
      };
    }
    return {
      metadata,
      journal,
      lastEvent: journal.events[journal.events.length - 1] ?? null,
    };
  }

  /** Explicit, targeted discard of one validated session directory. */
  async discard(paths: SessionPaths): Promise<void> {
    const metadata = await SessionMetadataStore.read(paths);
    if (metadata && metadata.sessionId !== paths.sessionId) {
      throw new Error(
        `refusing to discard: metadata sessionId ${metadata.sessionId} != directory ${paths.sessionId}`,
      );
    }
    await fs.rm(paths.sessionDir, { recursive: true, force: true });
  }
}
