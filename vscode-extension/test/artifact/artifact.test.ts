import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as yazl from "yazl";
import { sha256Hex } from "../../src/capture/hash";
import type { CheckpointMeta, SessionEvent } from "../../src/model/events";
import { openArtifact } from "../../src/storage/ArtifactReader";
import { writeArtifact } from "../../src/storage/ArtifactWriter";
import { CheckpointStore } from "../../src/storage/CheckpointStore";
import { readJournal } from "../../src/storage/JournalReader";
import { OrderedJournalWriter } from "../../src/storage/OrderedJournalWriter";
import { buildSeekIndex } from "../../src/storage/SeekIndexBuilder";
import type { SessionMetadata } from "../../src/storage/SessionMetadataStore";
import { SessionPaths } from "../../src/storage/SessionPaths";
import { buildRawZip, type RawZipEntry } from "./rawZip";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nr-artifact-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// ---- golden fixture: a small honest session written with real stores ----

const DOC1_INITIAL = "line one\nline two\n";
const DOC1_AFTER = "line ONE\nline two\nline three\n";
const DOC2_INITIAL = "célèbre 😀\n";

async function buildWorkingSession(): Promise<{
  paths: SessionPaths;
  metadata: SessionMetadata;
  eventCount: number;
}> {
  const paths = new SessionPaths(dir, "session-test");
  await fs.mkdir(paths.checkpointsDir, { recursive: true });
  const checkpoints = new CheckpointStore(paths.checkpointsDir);
  const journal = await OrderedJournalWriter.open(paths.journalFile);

  let seq = 0;
  let tUs = 0;
  const push = (type: SessionEvent["type"], payload: unknown) => {
    journal.enqueue({
      seq: seq++,
      tUs: (tUs += 100),
      type,
      payload,
    } as SessionEvent);
  };
  const checkpoint = async (
    checkpointId: string,
    documentId: string,
    text: string,
    reason: string,
    version: number,
  ) => {
    const meta = {
      checkpointId,
      documentId,
      reason,
      version,
      eol: "LF",
      byteLength: Buffer.byteLength(text, "utf8"),
      sha256: sha256Hex(text),
    } as CheckpointMeta;
    await checkpoints.write(meta, text);
    push("document.checkpoint", meta);
  };

  push("session.started", {
    sessionId: "session-test",
    extensionVersion: "0.0.1",
    vscodeVersion: "1.129.0",
    platform: "darwin",
    architecture: "arm64",
  });
  push("roots.snapshot", {
    roots: [{ rootId: "root-1", name: "main", ordinal: 0 }],
  });

  const enroll = async (documentId: string, name: string, text: string) => {
    const checkpointId = `cp-init-${documentId}`;
    const meta = {
      checkpointId,
      documentId,
      reason: "enrollment",
      version: 1,
      eol: "LF",
      byteLength: Buffer.byteLength(text, "utf8"),
      sha256: sha256Hex(text),
    } as CheckpointMeta;
    await checkpoints.write(meta, text);
    push("document.enrolled", {
      descriptor: {
        documentId,
        rootId: "root-1",
        logicalPath: `src/${name}`,
        displayName: name,
        schemeClass: "file",
        languageId: "plaintext",
        eol: "LF",
        initialVersion: 1,
        initialCheckpointId: checkpointId,
        byteLength: Buffer.byteLength(text, "utf8"),
        sha256: sha256Hex(text),
      },
    });
    push("document.checkpoint", meta);
  };

  await enroll("doc-1", "one.txt", DOC1_INITIAL);
  await enroll("doc-2", "two.txt", DOC2_INITIAL);

  push("surface.opened", {
    surfaceId: "surf-1",
    documentId: "doc-1",
    groupId: null,
    viewColumn: 1,
    selections: [],
    visibleRanges: [],
    isActive: true,
  });
  push("topology.snapshot", {
    groups: [
      {
        groupId: "g-1",
        viewColumn: 1,
        isActive: true,
        activeTabId: "t-1",
        tabs: [
          {
            tabId: "t-1",
            kind: "text",
            documentId: "doc-1",
            label: "one.txt",
            isActive: true,
            isPinned: false,
            isPreview: false,
          },
        ],
      },
    ],
    activeGroupId: "g-1",
    fidelity: "reconstructed-no-geometry",
    discontinuity: false,
  });

  // Two real patches with exact hashes.
  const mid = "line ONE\nline two\n";
  push("document.patch", {
    documentId: "doc-1",
    beforeVersion: 1,
    afterVersion: 2,
    reason: "unknown",
    changes: [{ rangeOffsetUtf16: 5, rangeLengthUtf16: 3, text: "ONE" }],
    beforeHash: sha256Hex(DOC1_INITIAL),
    afterHash: sha256Hex(mid),
    eolBefore: "LF",
    eolAfter: "LF",
  });
  push("document.patch", {
    documentId: "doc-1",
    beforeVersion: 2,
    afterVersion: 3,
    reason: "unknown",
    changes: [
      {
        rangeOffsetUtf16: mid.length,
        rangeLengthUtf16: 0,
        text: "line three\n",
      },
    ],
    beforeHash: sha256Hex(mid),
    afterHash: sha256Hex(DOC1_AFTER),
    eolBefore: "LF",
    eolAfter: "LF",
  });
  await checkpoint("cp-stop-1", "doc-1", DOC1_AFTER, "stop", 3);

  push("session.stopping", { reason: "user" });
  push("session.finalized", { eventCount: seq + 1, durationUs: tUs + 100 });

  await journal.close();
  const metadata: SessionMetadata = {
    formatVersion: 1,
    sessionId: "session-test",
    state: "finalizing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastDurableSeq: seq - 1,
    extensionVersion: "0.0.1",
    vscodeVersion: "1.129.0",
    failure: null,
    artifactPath: null,
  };
  return { paths, metadata, eventCount: seq };
}

describe("artifact round trip", () => {
  it("writes, validates, reopens, and serves verified content", async () => {
    const { paths, metadata, eventCount } = await buildWorkingSession();
    const outputPath = path.join(dir, "out.nextrecording");
    const result = await writeArtifact({ paths, metadata, outputPath });
    expect(result.artifactPath).toBe(outputPath);
    expect(result.manifest.eventJournalRef.eventCount).toBe(eventCount);
    expect(result.manifest.documents).toHaveLength(2);

    const reader = await openArtifact(outputPath);
    try {
      expect(reader.manifest.sessionId).toBe("session-test");
      expect(reader.manifest.workspaceRoots).toHaveLength(1);
      expect(reader.seekIndex.eventCount).toBe(eventCount);

      const events = await reader.readEvents();
      expect(events).toHaveLength(eventCount);
      expect(events[events.length - 1]?.type).toBe("session.finalized");

      expect(await reader.readCheckpoint("doc-1", "cp-init-doc-1")).toBe(DOC1_INITIAL);
      expect(await reader.readCheckpoint("doc-2", "cp-init-doc-2")).toBe(DOC2_INITIAL);
      expect(await reader.readCheckpoint("doc-1", "cp-stop-1")).toBe(DOC1_AFTER);
    } finally {
      await reader.close();
    }
  });

  it("rejects a truncated archive", async () => {
    const { paths, metadata } = await buildWorkingSession();
    const outputPath = path.join(dir, "out.nextrecording");
    await writeArtifact({ paths, metadata, outputPath });
    const bytes = await fs.readFile(outputPath);
    const truncated = path.join(dir, "truncated.nextrecording");
    await fs.writeFile(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(openArtifact(truncated)).rejects.toThrow(/archive|zip|entry|end of central/i);
  });

  it("detects tampered checkpoint content via integrity hashes", async () => {
    const { paths, metadata } = await buildWorkingSession();
    const outputPath = path.join(dir, "out.nextrecording");
    const { manifest } = await writeArtifact({ paths, metadata, outputPath });

    // Rebuild the archive with one flipped checkpoint body but the
    // original manifest/integrity tables (byte-identical serialization:
    // `manifest` is the exact object the writer serialized, and the seek
    // index is regenerated through the same deterministic code path).
    const journalBytes = await fs.readFile(paths.journalFile);
    const journalRead = await readJournal(paths.journalFile);
    const indexStr = JSON.stringify(buildSeekIndex(journalRead.events, journalRead.byteOffsets));
    const manifestStr = JSON.stringify(manifest);
    const integrityStr = JSON.stringify({
      entries: {
        ...manifest.integrity.entries,
        "manifest.json": sha256Hex(manifestStr),
      },
    });

    const entries: RawZipEntry[] = [
      { name: "manifest.json", data: manifestStr },
      { name: "events.ndjson", data: journalBytes },
      { name: "index.json", data: indexStr },
      {
        name: "documents/doc-1/checkpoints/cp-init-doc-1.txt",
        data: "TAMPERED CONTENT",
      },
      { name: "integrity.json", data: integrityStr },
    ];
    const tampered = path.join(dir, "tampered.nextrecording");
    await fs.writeFile(tampered, buildRawZip(entries));

    const reader = await openArtifact(tampered);
    try {
      await expect(reader.readCheckpoint("doc-1", "cp-init-doc-1")).rejects.toThrow(
        /hash mismatch/,
      );
    } finally {
      await reader.close();
    }
  });
});

describe("hostile archives fail closed", () => {
  const write = async (name: string, entries: RawZipEntry[]): Promise<string> => {
    const file = path.join(dir, name);
    await fs.writeFile(file, buildRawZip(entries));
    return file;
  };
  const minimalManifest = () => JSON.stringify({ kind: "next-recording", formatVersion: 1 });

  it("rejects path traversal entry names", async () => {
    const file = await write("traversal.nextrecording", [
      { name: "manifest.json", data: minimalManifest() },
      { name: "../evil.txt", data: "x" },
    ]);
    await expect(openArtifact(file)).rejects.toThrow(
      /path|relative|absolute|drive|invalid|manifest/i,
    );
  });

  it("rejects absolute entry paths", async () => {
    const file = await write("absolute.nextrecording", [
      { name: "/etc/passwd", data: "x" },
      { name: "manifest.json", data: minimalManifest() },
    ]);
    await expect(openArtifact(file)).rejects.toThrow(
      /path|relative|absolute|drive|invalid|manifest/i,
    );
  });

  it("rejects drive-letter entry paths", async () => {
    const file = await write("drive.nextrecording", [
      { name: "C:evil.txt", data: "x" },
      { name: "manifest.json", data: minimalManifest() },
    ]);
    await expect(openArtifact(file)).rejects.toThrow(
      /path|relative|absolute|drive|invalid|manifest/i,
    );
  });

  it("rejects duplicate entries", async () => {
    const file = await write("dupes.nextrecording", [
      { name: "manifest.json", data: minimalManifest() },
      { name: "manifest.json", data: minimalManifest() },
    ]);
    await expect(openArtifact(file)).rejects.toThrow(/duplicate/);
  });

  it("rejects a missing manifest", async () => {
    const file = await write("nomanifest.nextrecording", [
      { name: "events.ndjson", data: "" },
      { name: "integrity.json", data: "{}" },
    ]);
    await expect(openArtifact(file)).rejects.toThrow(/manifest/);
  });

  it("rejects invalid manifest JSON", async () => {
    const file = await write("badjson.nextrecording", [
      { name: "manifest.json", data: "{not json" },
      { name: "integrity.json", data: JSON.stringify({ entries: {} }) },
    ]);
    await expect(openArtifact(file)).rejects.toThrow(
      /path|relative|absolute|drive|invalid|manifest/i,
    );
  });

  it("rejects an unsupported format version", async () => {
    const manifest = JSON.stringify({
      kind: "next-recording",
      formatVersion: 2,
    });
    const integrity = JSON.stringify({
      entries: { "manifest.json": sha256Hex(manifest) },
    });
    const file = await write("future.nextrecording", [
      { name: "manifest.json", data: manifest },
      { name: "integrity.json", data: integrity },
    ]);
    await expect(openArtifact(file)).rejects.toThrow(/unsupported format version/);
  });

  it("rejects an oversized manifest", async () => {
    const big = `{"kind":"next-recording","formatVersion":1,"pad":"${"x".repeat(3 * 1024 * 1024)}"}`;
    const file = await write("bigmanifest.nextrecording", [
      { name: "manifest.json", data: big },
      { name: "integrity.json", data: JSON.stringify({ entries: {} }) },
    ]);
    await expect(openArtifact(file)).rejects.toThrow(/size limit/);
  });

  it("rejects manifests whose hash does not match integrity.json", async () => {
    const manifest = minimalManifest();
    const file = await write("badhash.nextrecording", [
      { name: "manifest.json", data: manifest },
      {
        name: "integrity.json",
        data: JSON.stringify({
          entries: { "manifest.json": sha256Hex("other") },
        }),
      },
    ]);
    await expect(openArtifact(file)).rejects.toThrow(/hash mismatch/);
  });

  it("rejects excessive decompression ratios", async () => {
    const file = path.join(dir, "bomb.nextrecording");
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(minimalManifest()), "manifest.json");
    // 64 MiB of zeros deflates to a few KiB: ratio far above the limit.
    zip.addBuffer(Buffer.alloc(64 * 1024 * 1024), "documents/d/checkpoints/c.txt");
    zip.end();
    await new Promise<void>((resolve, reject) => {
      const stream = zip.outputStream.pipe(createWriteStream(file));
      stream.on("close", () => resolve());
      stream.on("error", reject);
    });
    await expect(openArtifact(file)).rejects.toThrow(/ratio/);
  });

  it("rejects event streams with sequence gaps inside a valid container", async () => {
    const events =
      `${JSON.stringify({ seq: 0, tUs: 0, type: "marker", payload: { label: "a" } })}\n` +
      `${JSON.stringify({ seq: 2, tUs: 1, type: "marker", payload: { label: "b" } })}\n`;
    const index = JSON.stringify({
      version: 1,
      bucketUs: 1_000_000,
      durationUs: 1,
      eventCount: 2,
      buckets: [],
    });
    const manifest = JSON.stringify({
      kind: "next-recording",
      formatVersion: 1,
      sessionId: "s",
      createdAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      durationUs: 1,
      producer: {
        extensionVersion: "0",
        vscodeVersion: "0",
        platform: "test",
        architecture: "test",
      },
      timebase: { kind: "host-monotonic-us" },
      capabilities: {
        textDocuments: true,
        selections: true,
        verticalViewport: true,
        topology: true,
        audio: false,
        unsupportedSurfaceMarkers: true,
      },
      limitsApplied: [],
      workspaceRoots: [],
      documents: [],
      tabs: [],
      initialTopologyRef: null,
      eventJournalRef: { entry: "events.ndjson", eventCount: 2 },
      seekIndexRef: { entry: "index.json" },
      audioTracks: [],
      integrity: {
        entries: {
          "events.ndjson": sha256Hex(events),
          "index.json": sha256Hex(index),
        },
      },
    });
    const integrity = JSON.stringify({
      entries: {
        "manifest.json": sha256Hex(manifest),
        "events.ndjson": sha256Hex(events),
        "index.json": sha256Hex(index),
      },
    });
    const file = await write("gap.nextrecording", [
      { name: "manifest.json", data: manifest },
      { name: "events.ndjson", data: events },
      { name: "index.json", data: index },
      { name: "integrity.json", data: integrity },
    ]);
    const reader = await openArtifact(file);
    try {
      await expect(reader.readEvents()).rejects.toThrow(/sequence gap/);
    } finally {
      await reader.close();
    }
  });
});
