// Builds the §21.4 reproduction fixtures with synthetic, non-sensitive
// content, using the real storage stack (bundled and run by
// scripts/generate-fixture.mjs).
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CheckpointMeta, SessionEvent } from "../src/model/events";
import { writeArtifact } from "../src/storage/ArtifactWriter";
import { CheckpointStore } from "../src/storage/CheckpointStore";
import { OrderedJournalWriter } from "../src/storage/OrderedJournalWriter";
import type { SessionMetadata } from "../src/storage/SessionMetadataStore";
import { SessionPaths } from "../src/storage/SessionPaths";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type DocSpec = { documentId: string; name: string; text: string };
type SurfaceSpec = {
  surfaceId: string;
  documentId: string;
  groupId: string;
  column: number;
};
type PatchSpec = {
  documentId: string;
  offset: number;
  length: number;
  text: string;
};

async function buildFixture(options: {
  workDir: string;
  outFile: string;
  sessionId: string;
  docs: DocSpec[];
  surfaces: SurfaceSpec[];
  groups: {
    groupId: string;
    column: number;
    tabs: { tabId: string; documentId: string; name: string }[];
  }[];
  patches: PatchSpec[];
}): Promise<void> {
  const paths = new SessionPaths(options.workDir, options.sessionId);
  await fs.mkdir(paths.checkpointsDir, { recursive: true });
  const checkpoints = new CheckpointStore(paths.checkpointsDir);
  const journal = await OrderedJournalWriter.open(paths.journalFile);
  const texts = new Map(options.docs.map((doc) => [doc.documentId, doc.text]));
  const versions = new Map(options.docs.map((doc) => [doc.documentId, 1]));

  let seq = 0;
  let tUs = 0;
  const push = (type: SessionEvent["type"], payload: unknown) => {
    journal.enqueue({
      seq: seq++,
      tUs: (tUs += 250_000),
      type,
      payload,
    } as SessionEvent);
  };

  push("session.started", {
    sessionId: options.sessionId,
    extensionVersion: "0.0.1",
    vscodeVersion: "1.129.0",
    platform: "fixture",
    architecture: "fixture",
  });
  push("roots.snapshot", {
    roots: [{ rootId: "root-1", name: "fixture-workspace", ordinal: 0 }],
  });

  for (const doc of options.docs) {
    const checkpointId = `cp-${doc.documentId}`;
    const meta = {
      checkpointId,
      documentId: doc.documentId,
      reason: "enrollment",
      version: 1,
      eol: "LF",
      byteLength: Buffer.byteLength(doc.text, "utf8"),
      sha256: sha256(doc.text),
    } as CheckpointMeta;
    await checkpoints.write(meta, doc.text);
    push("document.enrolled", {
      descriptor: {
        documentId: doc.documentId,
        rootId: "root-1",
        logicalPath: `src/${doc.name}`,
        displayName: doc.name,
        schemeClass: "file",
        languageId: "plaintext",
        eol: "LF",
        initialVersion: 1,
        initialCheckpointId: checkpointId,
        byteLength: Buffer.byteLength(doc.text, "utf8"),
        sha256: sha256(doc.text),
      },
    });
    push("document.checkpoint", meta);
  }

  for (const surface of options.surfaces) {
    push("surface.opened", {
      surfaceId: surface.surfaceId,
      documentId: surface.documentId,
      groupId: surface.groupId,
      viewColumn: surface.column,
      selections: [{ anchorOffsetUtf16: 0, activeOffsetUtf16: 0 }],
      visibleRanges: [{ startLine: 0, startCharacter: 0, endLine: 20, endCharacter: 0 }],
      isActive: surface === options.surfaces[0],
    });
  }

  push("topology.snapshot", {
    groups: options.groups.map((group, index) => ({
      groupId: group.groupId,
      viewColumn: group.column,
      isActive: index === 0,
      activeTabId: group.tabs[0]?.tabId ?? null,
      tabs: group.tabs.map((tab, tabIndex) => ({
        tabId: tab.tabId,
        kind: "text",
        documentId: tab.documentId,
        label: tab.name,
        isActive: tabIndex === 0,
        isPinned: false,
        isPreview: false,
      })),
    })),
    activeGroupId: options.groups[0]?.groupId ?? null,
    fidelity: "reconstructed-no-geometry",
    discontinuity: false,
  });

  for (const patch of options.patches) {
    const before = texts.get(patch.documentId) as string;
    const after =
      before.slice(0, patch.offset) + patch.text + before.slice(patch.offset + patch.length);
    const beforeVersion = versions.get(patch.documentId) as number;
    push("document.patch", {
      documentId: patch.documentId,
      beforeVersion,
      afterVersion: beforeVersion + 1,
      reason: "unknown",
      changes: [
        {
          rangeOffsetUtf16: patch.offset,
          rangeLengthUtf16: patch.length,
          text: patch.text,
        },
      ],
      beforeHash: sha256(before),
      afterHash: sha256(after),
      eolBefore: "LF",
      eolAfter: "LF",
    });
    texts.set(patch.documentId, after);
    versions.set(patch.documentId, beforeVersion + 1);
  }

  push("session.stopping", { reason: "user" });
  push("session.finalized", { eventCount: seq + 1, durationUs: tUs });
  await journal.close();

  const metadata: SessionMetadata = {
    formatVersion: 1,
    sessionId: options.sessionId,
    state: "finalizing",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    lastDurableSeq: seq - 1,
    extensionVersion: "0.0.1",
    vscodeVersion: "1.129.0",
    failure: null,
    artifactPath: null,
  };
  await fs.mkdir(path.dirname(options.outFile), { recursive: true });
  await writeArtifact({ paths, metadata, outputPath: options.outFile });
  console.log(`wrote ${options.outFile}`);
}

async function main(): Promise<void> {
  const fixturesRoot = path.resolve(process.argv[2] ?? "fixtures/recordings");
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nr-fixturegen-"));
  const poem = [
    "the quick brown fox",
    "jumps over the lazy dog",
    "pack my box with five dozen jugs",
    "sphinx of black quartz judge my vow",
  ].join("\n");

  try {
    await buildFixture({
      workDir: path.join(workRoot, "minimal"),
      outFile: path.join(fixturesRoot, "minimal", "minimal.nextrecording"),
      sessionId: "fixture-minimal",
      docs: [{ documentId: "doc-a", name: "notes.txt", text: `${poem}\n` }],
      surfaces: [{ surfaceId: "surf-1", documentId: "doc-a", groupId: "g-1", column: 1 }],
      groups: [
        {
          groupId: "g-1",
          column: 1,
          tabs: [{ tabId: "t-1", documentId: "doc-a", name: "notes.txt" }],
        },
      ],
      patches: [
        { documentId: "doc-a", offset: 0, length: 3, text: "THE" },
        { documentId: "doc-a", offset: 4, length: 5, text: "swift" },
      ],
    });

    await buildFixture({
      workDir: path.join(workRoot, "multi"),
      outFile: path.join(fixturesRoot, "multi-document", "multi-document.nextrecording"),
      sessionId: "fixture-multi-document",
      docs: [
        {
          documentId: "doc-a",
          name: "alpha.txt",
          text: "alpha file\nline two\n",
        },
        {
          documentId: "doc-b",
          name: "beta.txt",
          text: "beta file\nline two\n",
        },
        {
          documentId: "doc-c",
          name: "gamma.txt",
          text: "gamma file\nline two\n",
        },
      ],
      surfaces: [
        { surfaceId: "surf-1", documentId: "doc-a", groupId: "g-1", column: 1 },
        { surfaceId: "surf-2", documentId: "doc-b", groupId: "g-2", column: 2 },
      ],
      groups: [
        {
          groupId: "g-1",
          column: 1,
          tabs: [
            { tabId: "t-1", documentId: "doc-a", name: "alpha.txt" },
            { tabId: "t-3", documentId: "doc-c", name: "gamma.txt" },
          ],
        },
        {
          groupId: "g-2",
          column: 2,
          tabs: [{ tabId: "t-2", documentId: "doc-b", name: "beta.txt" }],
        },
      ],
      patches: [
        { documentId: "doc-a", offset: 0, length: 5, text: "ALPHA" },
        { documentId: "doc-b", offset: 0, length: 4, text: "BETA" },
        { documentId: "doc-c", offset: 0, length: 5, text: "GAMMA" },
        { documentId: "doc-a", offset: 5, length: 0, text: " (edited)" },
      ],
    });

    await buildFixture({
      workDir: path.join(workRoot, "dupe"),
      outFile: path.join(
        fixturesRoot,
        "same-document-two-surfaces",
        "same-document-two-surfaces.nextrecording",
      ),
      sessionId: "fixture-same-doc",
      docs: [
        {
          documentId: "doc-a",
          name: "shared.txt",
          text: "shared document\nsplit twice\n",
        },
      ],
      surfaces: [
        { surfaceId: "surf-1", documentId: "doc-a", groupId: "g-1", column: 1 },
        { surfaceId: "surf-2", documentId: "doc-a", groupId: "g-2", column: 2 },
      ],
      groups: [
        {
          groupId: "g-1",
          column: 1,
          tabs: [{ tabId: "t-1", documentId: "doc-a", name: "shared.txt" }],
        },
        {
          groupId: "g-2",
          column: 2,
          tabs: [{ tabId: "t-2", documentId: "doc-a", name: "shared.txt" }],
        },
      ],
      patches: [{ documentId: "doc-a", offset: 0, length: 6, text: "SHARED" }],
    });

    // Intentionally corrupt: a valid minimal artifact, truncated mid-file.
    const minimalBytes = await fs.readFile(
      path.join(fixturesRoot, "minimal", "minimal.nextrecording"),
    );
    const corruptDir = path.join(fixturesRoot, "corrupt");
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(
      path.join(corruptDir, "truncated.nextrecording"),
      minimalBytes.subarray(0, Math.floor(minimalBytes.length / 2)),
    );
    console.log(`wrote ${path.join(corruptDir, "truncated.nextrecording")}`);
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

void main();
