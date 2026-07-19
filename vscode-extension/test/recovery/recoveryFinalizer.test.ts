import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/capture/hash";
import type { CheckpointMeta, SessionEvent } from "../../src/model/events";
import { openArtifact } from "../../src/storage/ArtifactReader";
import { CheckpointStore } from "../../src/storage/CheckpointStore";
import { OrderedJournalWriter } from "../../src/storage/OrderedJournalWriter";
import { finalizeRecoveredSession } from "../../src/storage/RecoveryFinalizer";
import { SessionMetadataStore } from "../../src/storage/SessionMetadataStore";
import { SessionPaths } from "../../src/storage/SessionPaths";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nr-recfin-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const INITIAL = "alpha\nbeta\n";
const AFTER = "ALPHA!\nbeta\n";

// An interrupted session: valid prefix, no session.stopping/finalized.
async function buildInterruptedSession(sessionId = "sess-crash"): Promise<SessionPaths> {
  const paths = new SessionPaths(dir, sessionId);
  await fs.mkdir(paths.checkpointsDir, { recursive: true });
  const checkpoints = new CheckpointStore(paths.checkpointsDir);
  const journal = await OrderedJournalWriter.open(paths.journalFile);

  const checkpointMeta = {
    checkpointId: "cp-0",
    documentId: "doc-1",
    reason: "enrollment",
    version: 1,
    eol: "LF",
    byteLength: Buffer.byteLength(INITIAL),
    sha256: sha256Hex(INITIAL),
  } as CheckpointMeta;
  await checkpoints.write(checkpointMeta, INITIAL);

  let seq = 0;
  const push = (type: SessionEvent["type"], payload: unknown) => {
    journal.enqueue({
      seq: seq++,
      tUs: seq * 50,
      type,
      payload,
    } as SessionEvent);
  };
  push("session.started", {
    sessionId,
    extensionVersion: "0.0.1",
    vscodeVersion: "1.129.0",
    platform: "darwin",
    architecture: "arm64",
  });
  push("roots.snapshot", { roots: [] });
  push("document.enrolled", {
    descriptor: {
      documentId: "doc-1",
      rootId: null,
      logicalPath: "a.txt",
      displayName: "a.txt",
      schemeClass: "file",
      languageId: "plaintext",
      eol: "LF",
      initialVersion: 1,
      initialCheckpointId: "cp-0",
      byteLength: Buffer.byteLength(INITIAL),
      sha256: sha256Hex(INITIAL),
    },
  });
  push("document.patch", {
    documentId: "doc-1",
    beforeVersion: 1,
    afterVersion: 2,
    reason: "unknown",
    changes: [{ rangeOffsetUtf16: 0, rangeLengthUtf16: 5, text: "ALPHA!" }],
    beforeHash: sha256Hex(INITIAL),
    afterHash: sha256Hex(AFTER),
    eolBefore: "LF",
    eolAfter: "LF",
  });
  await journal.close();

  const store = SessionMetadataStore.createInitial(paths, {
    extensionVersion: "0.0.1",
    vscodeVersion: "1.129.0",
  });
  await store.update({ state: "recording", lastDurableSeq: seq - 1 });
  return paths;
}

type OkResult = Extract<Awaited<ReturnType<typeof finalizeRecoveredSession>>, { ok: true }>;

function expectOk(result: Awaited<ReturnType<typeof finalizeRecoveredSession>>): OkResult {
  if (!result.ok) {
    throw new Error(`expected ok result, got failure: ${result.message}`);
  }
  return result;
}

describe("finalizeRecoveredSession", () => {
  it("finalizes an interrupted session into a valid artifact", async () => {
    const paths = await buildInterruptedSession();
    const result = expectOk(await finalizeRecoveredSession(dir, paths.sessionId));
    expect(result.alreadyFinalized).toBe(false);
    expect(result.recoveredEvents).toBe(6); // 4 recorded + recovered + finalized

    const reader = await openArtifact(result.artifactPath);
    try {
      const events = await reader.readEvents();
      expect(events.map((event) => event.type).slice(-2)).toEqual([
        "session.recovered",
        "session.finalized",
      ]);
      expect(await reader.readCheckpoint("doc-1", "cp-0")).toBe(INITIAL);
    } finally {
      await reader.close();
    }

    const metadata = await SessionMetadataStore.read(paths);
    expect(metadata?.state).toBe("finalized");
    expect(metadata?.artifactPath).toBe(result.artifactPath);
  });

  it("is idempotent: a second call returns the same artifact", async () => {
    const paths = await buildInterruptedSession();
    const first = expectOk(await finalizeRecoveredSession(dir, paths.sessionId));
    const second = expectOk(await finalizeRecoveredSession(dir, paths.sessionId));
    expect(second.alreadyFinalized).toBe(true);
    expect(second.artifactPath).toBe(first.artifactPath);
  });

  it("drops a truncated tail line and still finalizes", async () => {
    const paths = await buildInterruptedSession();
    await fs.appendFile(paths.journalFile, '{"seq":4,"tUs":250,"type":"docu');
    const result = expectOk(await finalizeRecoveredSession(dir, paths.sessionId));
    expect(result.droppedTailBytes).toBeGreaterThan(0);
    const reader = await openArtifact(result.artifactPath);
    try {
      const events = await reader.readEvents();
      expect(events[events.length - 1]?.type).toBe("session.finalized");
    } finally {
      await reader.close();
    }
  });

  it("truncates at pre-tail corruption and records it", async () => {
    const paths = await buildInterruptedSession();
    await fs.appendFile(
      paths.journalFile,
      'GARBAGE LINE\n{"seq":5,"tUs":300,"type":"marker","payload":{"label":"after"}}\n',
    );
    const result = expectOk(await finalizeRecoveredSession(dir, paths.sessionId));
    expect(result.corruptionTruncated).toBe(true);
    const reader = await openArtifact(result.artifactPath);
    try {
      const events = await reader.readEvents();
      // Only the 4 valid prefix events plus the two closers survive.
      expect(events).toHaveLength(6);
    } finally {
      await reader.close();
    }
  });

  it("refuses to finalize a discarded session", async () => {
    const paths = await buildInterruptedSession();
    const store = new SessionMetadataStore(paths, (await SessionMetadataStore.read(paths))!);
    await store.update({ state: "discarded" });
    const result = await finalizeRecoveredSession(dir, paths.sessionId);
    expect(result.ok).toBe(false);
  });

  it("fails cleanly when a checkpoint body is missing, preserving the session", async () => {
    const paths = await buildInterruptedSession();
    await fs.rm(path.join(paths.checkpointsDir, "cp-0.txt"));
    const result = await finalizeRecoveredSession(dir, paths.sessionId);
    expect(result.ok).toBe(false);
    // Working directory preserved for inspection.
    const journalStat = await fs.stat(paths.journalFile);
    expect(journalStat.isFile()).toBe(true);
    const metadata = await SessionMetadataStore.read(paths);
    expect(metadata?.state).toBe("failed");
  });
});
