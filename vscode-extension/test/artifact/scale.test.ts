import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/model/events";
import { openArtifact } from "../../src/storage/ArtifactReader";
import { writeArtifact } from "../../src/storage/ArtifactWriter";
import { OrderedJournalWriter } from "../../src/storage/OrderedJournalWriter";
import type { SessionMetadata } from "../../src/storage/SessionMetadataStore";
import { SessionPaths } from "../../src/storage/SessionPaths";
import { benchmarkFixtureConfigs, generateFixture } from "../../src/webview/player/fixtures";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nr-scale-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// Long-session scale hardening (plan §15 Phase 7): the 60-minute /
// 250k-event fixture flows through the real journal writer, artifact
// writer, and fail-closed reader end to end.
describe("long-session scale", () => {
  it("packages and re-reads a 250k-event session", { timeout: 120_000 }, async () => {
    const config = benchmarkFixtureConfigs().find((c) => c.name === "long-session")!;
    const fixture = generateFixture(config);

    const paths = new SessionPaths(dir, "long-session");
    await fs.mkdir(paths.checkpointsDir, { recursive: true });

    // Checkpoint bodies (fixture hashes are synthetic-empty, so write the
    // files directly; the artifact writer hashes the real bytes).
    for (const [checkpointId, body] of Object.entries(fixture.checkpointBodies)) {
      await fs.writeFile(path.join(paths.checkpointsDir, `${checkpointId}.txt`), body, "utf8");
    }

    const journal = await OrderedJournalWriter.open(paths.journalFile);
    for (const event of fixture.events) {
      journal.enqueue(event);
    }
    // Close the stream the way a stop would.
    const last = fixture.events[fixture.events.length - 1] as SessionEvent;
    journal.enqueue({
      seq: last.seq + 1,
      tUs: last.tUs,
      type: "session.stopping",
      payload: { reason: "user" },
    } as SessionEvent);
    journal.enqueue({
      seq: last.seq + 2,
      tUs: last.tUs,
      type: "session.finalized",
      payload: { eventCount: last.seq + 3, durationUs: last.tUs },
    } as SessionEvent);
    await journal.close();

    const metadata: SessionMetadata = {
      formatVersion: 1,
      sessionId: "long-session",
      state: "finalizing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastDurableSeq: last.seq + 2,
      extensionVersion: "0.0.1",
      vscodeVersion: "1.129.0",
      failure: null,
      artifactPath: null,
    };

    const before = process.memoryUsage().heapUsed;
    const outputPath = path.join(dir, "long.nextrecording");
    const { manifest } = await writeArtifact({ paths, metadata, outputPath });
    expect(manifest.eventJournalRef.eventCount).toBe(fixture.events.length + 2);

    const reader = await openArtifact(outputPath);
    try {
      const events = await reader.readEvents();
      expect(events).toHaveLength(fixture.events.length + 2);
      expect(reader.seekIndex.buckets.length).toBeGreaterThan(3000);
    } finally {
      await reader.close();
    }
    const after = process.memoryUsage().heapUsed;
    // Bounded memory: writing + reading a 250k-event artifact must stay
    // within a few multiples of the event data itself (well under 2 GiB).
    expect(after - before).toBeLessThan(1.5 * 1024 * 1024 * 1024);

    const stat = await fs.stat(outputPath);
    expect(stat.size).toBeGreaterThan(1024 * 1024);
  });
});
