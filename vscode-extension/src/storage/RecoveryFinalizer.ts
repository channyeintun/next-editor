import * as fs from "node:fs/promises";
import type { SessionEvent } from "../model/events";
import { validateSessionEventRaw } from "../model/schemas";
import { atomicWriteFile, atomicWriteJson } from "./atomicFile";
import { writeArtifact } from "./ArtifactWriter";
import { CheckpointStore } from "./CheckpointStore";
import { readJournal } from "./JournalReader";
import { RecordingLibrary } from "./RecordingLibrary";
import { SessionMetadataStore } from "./SessionMetadataStore";
import { SessionPaths } from "./SessionPaths";
import { validateSessionReplay } from "./replayValidation";

export type RecoveryFinalizeResult =
  | {
      ok: true;
      alreadyFinalized: boolean;
      artifactPath: string;
      recoveredEvents: number;
      droppedTailBytes: number;
      corruptionTruncated: boolean;
    }
  | { ok: false; message: string };

// Idempotent finalization of an interrupted session (plan §9.8):
// recover the durable journal prefix, close the stream with explicit
// session.recovered / session.finalized events, validate, and package.
// Safe to re-run after another interruption at any step.
export async function finalizeRecoveredSession(
  storageRoot: string,
  sessionId: string,
): Promise<RecoveryFinalizeResult> {
  const paths = new SessionPaths(storageRoot, sessionId);
  const metadata = await SessionMetadataStore.read(paths);
  if (!metadata) {
    return { ok: false, message: "session metadata missing or unreadable" };
  }
  if (metadata.state === "discarded") {
    return { ok: false, message: "session was discarded" };
  }
  if (metadata.state === "finalized" && metadata.artifactPath) {
    const exists = await fs
      .access(metadata.artifactPath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      return {
        ok: true,
        alreadyFinalized: true,
        artifactPath: metadata.artifactPath,
        recoveredEvents: 0,
        droppedTailBytes: 0,
        corruptionTruncated: false,
      };
    }
  }

  try {
    // 1. Recover the durable prefix.
    const journal = await readJournal(paths.journalFile, validateSessionEventRaw);
    if (journal.events.length === 0) {
      return { ok: false, message: "no recoverable events in the journal" };
    }
    const events = [...journal.events];
    const lastEvent = events[events.length - 1] as SessionEvent;
    const corruptionTruncated = journal.corruption !== null;

    // 2. Close the stream explicitly unless a previous finalize already did.
    let rewriteNeeded = journal.truncatedTailBytes > 0 || corruptionTruncated;
    if (lastEvent.type !== "session.finalized") {
      const lastSeq = lastEvent.seq;
      const lastTUs = lastEvent.tUs;
      events.push({
        seq: lastSeq + 1,
        tUs: lastTUs,
        type: "session.recovered",
        payload: { recoveredThroughSeq: lastSeq },
      } as SessionEvent);
      events.push({
        seq: lastSeq + 2,
        tUs: lastTUs,
        type: "session.finalized",
        payload: { eventCount: lastSeq + 3, durationUs: lastTUs },
      } as SessionEvent);
      rewriteNeeded = true;
    }

    // 3. Validate the recovered stream before packaging.
    const checkpoints = new CheckpointStore(paths.checkpointsDir);
    const checkpointTexts = new Map<string, string>();
    for (const id of await checkpoints.list()) {
      checkpointTexts.set(id, await checkpoints.read(id));
    }
    const validation = validateSessionReplay(events, (id) => checkpointTexts.get(id));
    if (!validation.ok) {
      const message = `recovered session fails validation: ${validation.errors.slice(0, 3).join("; ")}`;
      // Keep failure information in recovery metadata (plan §8.1) while
      // preserving the working directory for inspection.
      await new SessionMetadataStore(paths, metadata)
        .update({
          state: "failed",
          failure: { message, at: new Date().toISOString() },
        })
        .catch(() => {});
      return { ok: false, message };
    }

    // 4. Rewrite the journal atomically (drops any truncated tail).
    if (rewriteNeeded) {
      const text = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      await atomicWriteFile(paths.journalFile, text);
    }

    // 5. Package (idempotent target name derived from the session).
    const metadataStore = new SessionMetadataStore(paths, metadata);
    await metadataStore.update({ state: "finalizing" });
    const library = new RecordingLibrary(storageRoot);
    const artifactPath =
      metadata.artifactPath ?? library.artifactPathFor(sessionId, new Date(metadata.createdAt));
    const artifact = await writeArtifact({
      paths,
      metadata: metadataStore.metadata,
      outputPath: artifactPath,
    });
    await atomicWriteJson(paths.finalizedFile, {
      finalizedAt: new Date().toISOString(),
      recovered: true,
      eventCount: events.length,
      droppedTailBytes: journal.truncatedTailBytes,
      corruptionTruncated,
      artifactPath: artifact.artifactPath,
    });
    await metadataStore.update({
      state: "finalized",
      artifactPath: artifact.artifactPath,
      lastDurableSeq: events[events.length - 1]?.seq ?? -1,
    });

    return {
      ok: true,
      alreadyFinalized: false,
      artifactPath: artifact.artifactPath,
      recoveredEvents: events.length,
      droppedTailBytes: journal.truncatedTailBytes,
      corruptionTruncated,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const metadataStore = new SessionMetadataStore(paths, metadata);
    await metadataStore
      .update({
        state: "failed",
        failure: { message, at: new Date().toISOString() },
      })
      .catch(() => {});
    return { ok: false, message };
  }
}
