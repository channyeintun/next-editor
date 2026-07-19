import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import * as yazl from "yazl";
import type { DocumentDescriptor, TabDescriptor, WorkspaceRootDescriptor } from "../model/events";
import { ARCHIVE_ENTRIES, type ManifestV1 } from "../model/manifest";
import { validateSessionEventRaw } from "../model/schemas";
import { CheckpointStore } from "./CheckpointStore";
import { readJournal } from "./JournalReader";
import { buildSeekIndex } from "./SeekIndexBuilder";
import type { SessionMetadata } from "./SessionMetadataStore";
import type { SessionPaths } from "./SessionPaths";
import { openArtifact } from "./ArtifactReader";

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), async (source) => {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
    }
  });
  return hash.digest("hex");
}

function sha256Buffer(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export type ArtifactBuildResult = {
  artifactPath: string;
  manifest: ManifestV1;
};

// Finalization order per plan §9.5: the caller has already drained and
// validated the working session. This builds the seek index, streams the
// archive to a temporary destination, syncs it, revalidates it by
// reopening, and atomically renames it into place.
export async function writeArtifact(options: {
  paths: SessionPaths;
  metadata: SessionMetadata;
  outputPath: string;
}): Promise<ArtifactBuildResult> {
  const { paths, metadata, outputPath } = options;

  const journal = await readJournal(paths.journalFile, validateSessionEventRaw);
  if (journal.corruption) {
    throw new Error(
      `journal corruption at line ${journal.corruption.line}: ${journal.corruption.message}`,
    );
  }
  if (journal.events.length === 0) {
    throw new Error("refusing to package an empty session");
  }
  const events = journal.events;

  // --- derive manifest tables -------------------------------------------
  const rootsById = new Map<string, WorkspaceRootDescriptor>();
  const documents: DocumentDescriptor[] = [];
  const checkpointDocs = new Map<string, string>(); // checkpointId -> documentId
  let tabs: TabDescriptor[] = [];
  let initialTopologySeq: number | null = null;

  for (const event of events) {
    if (event.type === "roots.snapshot") {
      for (const root of event.payload.roots) {
        rootsById.set(root.rootId, root);
      }
    } else if (event.type === "document.enrolled") {
      documents.push(event.payload.descriptor);
      checkpointDocs.set(
        event.payload.descriptor.initialCheckpointId,
        event.payload.descriptor.documentId,
      );
    } else if (event.type === "document.checkpoint") {
      checkpointDocs.set(event.payload.checkpointId, event.payload.documentId);
    } else if (event.type === "topology.snapshot") {
      if (initialTopologySeq === null) {
        initialTopologySeq = event.seq;
      }
      tabs = event.payload.groups.flatMap((group) => group.tabs);
    }
  }

  const durationUs = events[events.length - 1]?.tUs ?? 0;
  const seekIndex = buildSeekIndex(events, journal.byteOffsets);

  // --- integrity ----------------------------------------------------------
  const checkpoints = new CheckpointStore(paths.checkpointsDir);
  const integrityEntries: Record<string, string> = {};
  integrityEntries[ARCHIVE_ENTRIES.events] = await sha256File(paths.journalFile);

  const checkpointFiles: { entry: string; file: string }[] = [];
  for (const [checkpointId, documentId] of checkpointDocs) {
    const file = checkpoints.fileFor(checkpointId);
    try {
      await fs.access(file);
    } catch {
      throw new Error(`checkpoint body missing for ${checkpointId}`);
    }
    const entry = ARCHIVE_ENTRIES.checkpoint(documentId, checkpointId);
    checkpointFiles.push({ entry, file });
    integrityEntries[entry] = await sha256File(file);
  }

  const indexBuffer = Buffer.from(JSON.stringify(seekIndex), "utf8");
  integrityEntries[ARCHIVE_ENTRIES.index] = sha256Buffer(indexBuffer);

  const manifest: ManifestV1 = {
    kind: "next-recording",
    formatVersion: 1,
    sessionId: metadata.sessionId,
    createdAt: metadata.createdAt,
    finalizedAt: new Date().toISOString(),
    durationUs,
    producer: {
      extensionVersion: metadata.extensionVersion,
      vscodeVersion: metadata.vscodeVersion,
      platform: process.platform,
      architecture: process.arch,
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
    workspaceRoots: [...rootsById.values()],
    documents,
    tabs,
    initialTopologyRef: initialTopologySeq === null ? null : { eventSeq: initialTopologySeq },
    eventJournalRef: {
      entry: ARCHIVE_ENTRIES.events,
      eventCount: events.length,
    },
    seekIndexRef: { entry: ARCHIVE_ENTRIES.index },
    audioTracks: [],
    integrity: { entries: integrityEntries },
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");
  const integrityBuffer = Buffer.from(
    JSON.stringify({
      entries: {
        ...integrityEntries,
        [ARCHIVE_ENTRIES.manifest]: sha256Buffer(manifestBuffer),
      },
    }),
    "utf8",
  );

  // --- stream the archive --------------------------------------------------
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}`;
  const zip = new yazl.ZipFile();
  zip.addBuffer(manifestBuffer, ARCHIVE_ENTRIES.manifest);
  zip.addFile(paths.journalFile, ARCHIVE_ENTRIES.events);
  zip.addBuffer(indexBuffer, ARCHIVE_ENTRIES.index);
  for (const { entry, file } of checkpointFiles) {
    zip.addFile(file, entry);
  }
  zip.addBuffer(integrityBuffer, ARCHIVE_ENTRIES.integrity);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(tempPath));

  // Sync the finished archive before validating and renaming.
  const handle = await fs.open(tempPath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }

  // --- reopen and validate before the atomic rename ------------------------
  const reader = await openArtifact(tempPath);
  try {
    const readBack = await reader.readEvents();
    if (readBack.length !== events.length) {
      throw new Error(
        `artifact validation failed: event count ${readBack.length} != ${events.length}`,
      );
    }
    const tail = readBack[readBack.length - 1];
    if (tail?.type !== "session.finalized") {
      throw new Error("artifact validation failed: journal tail is not session.finalized");
    }
  } finally {
    await reader.close();
  }

  await fs.rename(tempPath, outputPath);
  return { artifactPath: outputPath, manifest };
}
