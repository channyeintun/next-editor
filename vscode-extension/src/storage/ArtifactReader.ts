import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import * as yauzl from "yauzl";
import type { DocumentDescriptor, SessionEvent } from "../model/events";
import { ARCHIVE_ENTRIES, type ManifestV1 } from "../model/manifest";
import { manifestSchema, seekIndexSchema, validateSessionEventRaw } from "../model/schemas";
import { LIMITS } from "../model/limits";
import { ARTIFACT_LIMITS, validateEntrySizes } from "../security/artifactLimits";
import { validateArchivePath } from "../security/safeArchivePath";
import type { SeekIndexV1 } from "./SeekIndexBuilder";

export class ArtifactError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

function fail(code: string, message: string): never {
  throw new ArtifactError(code, message);
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(data: Buffer, name: string): string {
  try {
    return utf8Decoder.decode(data);
  } catch {
    fail("utf8", `${name} is not valid UTF-8`);
  }
}

function documentDescriptorKey(descriptor: DocumentDescriptor): string {
  return JSON.stringify([
    descriptor.documentId,
    descriptor.rootId,
    descriptor.logicalPath,
    descriptor.displayName,
    descriptor.schemeClass,
    descriptor.languageId,
    descriptor.eol,
    descriptor.initialVersion,
    descriptor.initialCheckpointId,
    descriptor.byteLength,
    descriptor.sha256,
  ]);
}

type ZipHandle = {
  zipfile: yauzl.ZipFile;
  entries: Map<string, yauzl.Entry>;
};

function openZip(file: string): Promise<ZipHandle> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(new ArtifactError("zip-open", `not a readable archive: ${error?.message}`));
        return;
      }
      const entries = new Map<string, yauzl.Entry>();
      zipfile.on("entry", (entry: yauzl.Entry) => {
        try {
          if (entries.size >= ARTIFACT_LIMITS.maxEntries) {
            fail("entry-count", `more than ${ARTIFACT_LIMITS.maxEntries} entries`);
          }
          if (/[/\\]$/.test(entry.fileName)) {
            fail("entry-type", `directory entries are not allowed: ${entry.fileName}`);
          }
          // Reject symlinks and other unusual external attributes early:
          // the upper byte of externalFileAttributes holds unix mode bits.
          const unixMode = entry.externalFileAttributes >>> 16;
          const fileType = unixMode & 0xf000;
          if (fileType !== 0 && fileType !== 0x8000) {
            fail("entry-type", `unsupported entry type for ${entry.fileName}`);
          }
          const pathVerdict = validateArchivePath(entry.fileName);
          if (!pathVerdict.ok) {
            fail("entry-path", `${entry.fileName}: ${pathVerdict.reason}`);
          }
          if (entries.has(pathVerdict.normalized)) {
            fail("entry-duplicate", `duplicate entry ${pathVerdict.normalized}`);
          }
          const sizeVerdict = validateEntrySizes(
            entry.fileName,
            entry.compressedSize,
            entry.uncompressedSize,
          );
          if (!sizeVerdict.ok) {
            fail("entry-size", sizeVerdict.reason);
          }
          entries.set(pathVerdict.normalized, entry);
          zipfile.readEntry();
        } catch (validationError) {
          zipfile.close();
          reject(validationError);
        }
      });
      zipfile.on("end", () => resolve({ zipfile, entries }));
      zipfile.on("error", (zipError) => reject(new ArtifactError("zip-read", zipError.message)));
      zipfile.readEntry();
    });
  });
}

export class ArtifactReader {
  private extractedBytes: number;
  private readonly countedEntries = new Set<string>();
  private readonly checkpointMetadata = new Map<
    string,
    { documentId: string; byteLength: number; sha256: string }
  >();
  private eventsPromise: Promise<SessionEvent[]> | null = null;
  private eventsValidated = false;
  private closed = false;

  constructor(
    private readonly handle: ZipHandle,
    readonly manifest: ManifestV1,
    readonly seekIndex: SeekIndexV1,
    private readonly integrity: Record<string, string>,
    initialExtractedBytes = 0,
  ) {
    this.extractedBytes = initialExtractedBytes;
  }

  entryNames(): string[] {
    return [...this.handle.entries.keys()];
  }

  private async readEntryBuffer(name: string, maxBytes: number): Promise<Buffer> {
    if (this.closed) {
      fail("closed", "artifact reader is closed");
    }
    const entry = this.handle.entries.get(name);
    if (!entry) {
      fail("entry-missing", `archive entry missing: ${name}`);
    }
    if (entry.uncompressedSize > maxBytes) {
      fail("entry-size", `${name} exceeds limit (${entry.uncompressedSize} > ${maxBytes})`);
    }
    if (!this.countedEntries.has(name)) {
      this.countedEntries.add(name);
      this.extractedBytes += entry.uncompressedSize;
      if (this.extractedBytes > ARTIFACT_LIMITS.maxTotalExtractedBytes) {
        fail("total-size", "total extracted size limit exceeded");
      }
    }
    return new Promise((resolve, reject) => {
      this.handle.zipfile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(new ArtifactError("zip-read", `cannot read ${name}: ${error?.message}`));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        stream.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            stream.destroy();
            reject(new ArtifactError("entry-size", `${name} stream exceeded declared size`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", (streamError) =>
          reject(new ArtifactError("zip-read", `${name}: ${streamError.message}`)),
        );
      });
    });
  }

  private verifyHash(name: string, data: Buffer): void {
    const expected = this.integrity[name];
    if (!expected) {
      fail("integrity-missing", `no recorded hash for ${name}`);
    }
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expected) {
      fail("integrity", `hash mismatch for ${name}`);
    }
  }

  /** Full, verified, fail-closed event load (artifacts allow no tail). */
  readEvents(): Promise<SessionEvent[]> {
    this.eventsPromise ??= this.loadEvents();
    return this.eventsPromise;
  }

  private async loadEvents(): Promise<SessionEvent[]> {
    const buffer = await this.readEntryBuffer(
      this.manifest.eventJournalRef.entry,
      ARTIFACT_LIMITS.maxEventJournalBytes,
    );
    this.verifyHash(this.manifest.eventJournalRef.entry, buffer);
    const lines = decodeUtf8(buffer, this.manifest.eventJournalRef.entry).split("\n");
    const events: SessionEvent[] = [];
    const enrolledDocuments = new Map<string, DocumentDescriptor>();
    let lastTUs = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.trim() === "") {
        if (i === lines.length - 1 && line === "") {
          continue;
        }
        fail("events-json", `empty journal line ${i}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail("events-json", `invalid JSON at journal line ${i}`);
      }
      const schemaError = validateSessionEventRaw(parsed);
      if (schemaError !== null) {
        fail("events-schema", `line ${i}: ${schemaError}`);
      }
      const event = parsed as SessionEvent;
      if (event.seq !== events.length) {
        fail(
          "events-seq",
          `sequence gap at line ${i}: expected ${events.length}, got ${event.seq}`,
        );
      }
      if (event.tUs < lastTUs) {
        fail("events-time", `decreasing timestamp at seq ${event.seq}`);
      }
      lastTUs = event.tUs;
      events.push(event);
      if (event.type === "document.enrolled") {
        const descriptor = event.payload.descriptor;
        if (enrolledDocuments.has(descriptor.documentId)) {
          fail("events-reference", `duplicate enrollment for ${descriptor.documentId}`);
        }
        enrolledDocuments.set(descriptor.documentId, descriptor);
        this.registerCheckpointMetadata(
          descriptor.initialCheckpointId,
          descriptor.documentId,
          descriptor.byteLength,
          descriptor.sha256,
        );
      } else if (event.type === "document.checkpoint") {
        this.registerCheckpointMetadata(
          event.payload.checkpointId,
          event.payload.documentId,
          event.payload.byteLength,
          event.payload.sha256,
        );
      }
      if (events.length > LIMITS.maxEventsPerSession) {
        fail("events-count", `event count exceeds ${LIMITS.maxEventsPerSession}`);
      }
    }
    if (events.length !== this.manifest.eventJournalRef.eventCount) {
      fail(
        "events-count",
        `event count ${events.length} != manifest ${this.manifest.eventJournalRef.eventCount}`,
      );
    }
    const first = events[0];
    const tail = events[events.length - 1];
    if (first?.type !== "session.started" || first.payload.sessionId !== this.manifest.sessionId) {
      fail("events-start", "journal does not start with the manifest session");
    }
    if (tail?.type !== "session.finalized") {
      fail("events-tail", "journal tail is not session.finalized");
    }
    if (tail.payload.eventCount !== events.length) {
      fail("events-count", "session.finalized event count does not match journal");
    }
    if (tail.tUs !== this.manifest.durationUs) {
      fail("events-time", "manifest duration does not match journal tail");
    }
    const manifestDocuments = new Map<string, DocumentDescriptor>();
    for (const descriptor of this.manifest.documents) {
      if (manifestDocuments.has(descriptor.documentId)) {
        fail("manifest-schema", `duplicate manifest document ${descriptor.documentId}`);
      }
      manifestDocuments.set(descriptor.documentId, descriptor);
    }
    if (manifestDocuments.size !== enrolledDocuments.size) {
      fail("events-reference", "manifest document table does not match journal enrollments");
    }
    for (const [documentId, descriptor] of enrolledDocuments) {
      const manifestDescriptor = manifestDocuments.get(documentId);
      if (
        !manifestDescriptor ||
        documentDescriptorKey(manifestDescriptor) !== documentDescriptorKey(descriptor)
      ) {
        fail("events-reference", `manifest descriptor does not match journal for ${documentId}`);
      }
    }
    this.eventsValidated = true;
    return events;
  }

  /** Drop the materialized event array after a consumer has copied it. */
  releaseEvents(): void {
    if (this.eventsValidated) {
      this.eventsPromise = null;
    }
  }

  private registerCheckpointMetadata(
    checkpointId: string,
    documentId: string,
    byteLength: number,
    sha256: string,
  ): void {
    const existing = this.checkpointMetadata.get(checkpointId);
    if (
      existing &&
      (existing.documentId !== documentId ||
        existing.byteLength !== byteLength ||
        existing.sha256 !== sha256)
    ) {
      fail("events-reference", `conflicting metadata for checkpoint ${checkpointId}`);
    }
    this.checkpointMetadata.set(checkpointId, { documentId, byteLength, sha256 });
  }

  async readCheckpoint(documentId: string, checkpointId: string): Promise<string> {
    if (!this.eventsValidated) {
      await this.readEvents();
    }
    const metadata = this.checkpointMetadata.get(checkpointId);
    if (!metadata) {
      fail("checkpoint-reference", `checkpoint ${checkpointId} is not referenced by the journal`);
    }
    if (metadata.documentId !== documentId) {
      fail("checkpoint-reference", `checkpoint ${checkpointId} does not belong to ${documentId}`);
    }
    const entry = ARCHIVE_ENTRIES.checkpoint(documentId, checkpointId);
    const buffer = await this.readEntryBuffer(entry, ARTIFACT_LIMITS.maxCheckpointBytes);
    this.verifyHash(entry, buffer);
    if (buffer.byteLength !== metadata.byteLength) {
      fail("checkpoint-size", `checkpoint ${checkpointId} byte length does not match journal`);
    }
    if (metadata.sha256 && createHash("sha256").update(buffer).digest("hex") !== metadata.sha256) {
      fail("checkpoint-integrity", `checkpoint ${checkpointId} hash does not match journal`);
    }
    return decodeUtf8(buffer, entry);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.handle.zipfile.close();
    }
  }
}

// openCustomDocument path (plan §10.1): validate paths and size limits
// before extraction; parse and validate the manifest; reject unsupported
// required format versions; fail closed on every anomaly.
export async function openArtifact(file: string): Promise<ArtifactReader> {
  const handle = await openZip(file);
  try {
    const manifestEntry = handle.entries.get(ARCHIVE_ENTRIES.manifest);
    if (!manifestEntry) {
      fail("manifest-missing", "manifest.json missing");
    }
    if (manifestEntry.uncompressedSize > ARTIFACT_LIMITS.maxManifestBytes) {
      fail("manifest-size", "manifest.json exceeds size limit");
    }
    const integrityEntry = handle.entries.get(ARCHIVE_ENTRIES.integrity);
    if (!integrityEntry) {
      fail("integrity-missing", "integrity.json missing");
    }

    const readSmall = (entry: yauzl.Entry, name: string, maxBytes: number): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        if (entry.uncompressedSize > maxBytes) {
          reject(new ArtifactError("entry-size", `${name} exceeds size limit`));
          return;
        }
        handle.zipfile.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(new ArtifactError("zip-read", `cannot read ${name}`));
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          stream.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
              stream.destroy();
              reject(new ArtifactError("entry-size", `${name} stream exceeds size limit`));
              return;
            }
            chunks.push(chunk);
          });
          stream.on("end", () => resolve(Buffer.concat(chunks)));
          stream.on("error", (streamError) =>
            reject(new ArtifactError("zip-read", `${name}: ${streamError.message}`)),
          );
        });
      });

    const integrityRaw = await readSmall(
      integrityEntry,
      ARCHIVE_ENTRIES.integrity,
      ARTIFACT_LIMITS.maxIntegrityBytes,
    );
    let integrity: { entries?: Record<string, string> };
    try {
      integrity = JSON.parse(
        decodeUtf8(integrityRaw, ARCHIVE_ENTRIES.integrity),
      ) as typeof integrity;
    } catch {
      fail("integrity-json", "integrity.json is not valid JSON");
    }
    if (
      !integrity.entries ||
      typeof integrity.entries !== "object" ||
      Array.isArray(integrity.entries)
    ) {
      fail("integrity-json", "integrity.json has no entries table");
    }

    const integrityEntries: Record<string, string> = Object.create(null) as Record<string, string>;
    const integrityPairs = Object.entries(integrity.entries);
    if (integrityPairs.length > ARTIFACT_LIMITS.maxEntries) {
      fail("integrity-json", "integrity entry table exceeds archive entry limit");
    }
    for (const [name, digest] of integrityPairs) {
      const pathVerdict = validateArchivePath(name);
      if (!pathVerdict.ok || pathVerdict.normalized !== name) {
        fail("integrity-json", `unsafe integrity entry name: ${name}`);
      }
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
        fail("integrity-json", `invalid SHA-256 for ${name}`);
      }
      integrityEntries[name] = digest;
    }

    const manifestRaw = await readSmall(
      manifestEntry,
      ARCHIVE_ENTRIES.manifest,
      ARTIFACT_LIMITS.maxManifestBytes,
    );
    const manifestHash = createHash("sha256").update(manifestRaw).digest("hex");
    if (integrityEntries[ARCHIVE_ENTRIES.manifest] !== manifestHash) {
      fail("integrity", "manifest.json hash mismatch");
    }

    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(decodeUtf8(manifestRaw, ARCHIVE_ENTRIES.manifest));
    } catch {
      fail("manifest-json", "manifest.json is not valid JSON");
    }
    const kindProbe = manifestJson as {
      kind?: unknown;
      formatVersion?: unknown;
    };
    if (kindProbe.kind !== "next-recording") {
      fail("manifest-kind", "not a next-recording artifact");
    }
    if (kindProbe.formatVersion !== 1) {
      fail(
        "format-version",
        `unsupported format version ${String(kindProbe.formatVersion)} (supported: 1)`,
      );
    }
    const manifestResult = manifestSchema.safeParse(manifestJson);
    if (!manifestResult.success) {
      fail(
        "manifest-schema",
        `manifest invalid: ${manifestResult.error.issues[0]?.message ?? "unknown"}`,
      );
    }
    const manifest = manifestResult.data as ManifestV1;
    if (
      manifest.eventJournalRef.entry !== ARCHIVE_ENTRIES.events ||
      manifest.seekIndexRef.entry !== ARCHIVE_ENTRIES.index
    ) {
      fail("manifest-schema", "v1 archive entry references are not canonical");
    }
    const manifestIntegrityPairs = Object.entries(manifest.integrity.entries);
    if (manifestIntegrityPairs.length > ARTIFACT_LIMITS.maxEntries) {
      fail("manifest-schema", "manifest integrity table exceeds archive entry limit");
    }
    for (const [name, digest] of manifestIntegrityPairs) {
      const pathVerdict = validateArchivePath(name);
      if (!pathVerdict.ok || pathVerdict.normalized !== name || !/^[a-f0-9]{64}$/.test(digest)) {
        fail("manifest-schema", `invalid manifest integrity entry ${name}`);
      }
      if (integrityEntries[name] !== digest) {
        fail("integrity", `integrity tables disagree for ${name}`);
      }
      if (name === ARCHIVE_ENTRIES.manifest || name === ARCHIVE_ENTRIES.integrity) {
        fail("manifest-schema", `${name} cannot appear in manifest.integrity`);
      }
    }
    if (integrityPairs.length !== manifestIntegrityPairs.length + 1) {
      fail("integrity", "integrity.json contains unexpected or missing entries");
    }
    const expectedEntries = new Set([
      ARCHIVE_ENTRIES.manifest,
      ARCHIVE_ENTRIES.integrity,
      ...manifestIntegrityPairs.map(([name]) => name),
    ]);
    for (const name of expectedEntries) {
      if (!handle.entries.has(name)) {
        fail("entry-missing", `integrity references missing archive entry ${name}`);
      }
    }
    for (const name of handle.entries.keys()) {
      if (!expectedEntries.has(name)) {
        fail("integrity-missing", `archive entry is not covered by integrity: ${name}`);
      }
    }

    const indexEntry = handle.entries.get(manifest.seekIndexRef.entry);
    if (!indexEntry) {
      fail("index-missing", "seek index missing");
    }
    if (indexEntry.uncompressedSize > ARTIFACT_LIMITS.maxIndexBytes) {
      fail("index-size", "seek index exceeds size limit");
    }
    const indexRaw = await readSmall(
      indexEntry,
      manifest.seekIndexRef.entry,
      ARTIFACT_LIMITS.maxIndexBytes,
    );
    const indexHash = createHash("sha256").update(indexRaw).digest("hex");
    if (manifest.integrity.entries[manifest.seekIndexRef.entry] !== indexHash) {
      fail("integrity", "seek index hash mismatch");
    }
    let indexJson: unknown;
    try {
      indexJson = JSON.parse(decodeUtf8(indexRaw, manifest.seekIndexRef.entry));
    } catch {
      fail("index-json", "seek index is not valid JSON");
    }
    const indexResult = seekIndexSchema.safeParse(indexJson);
    if (!indexResult.success) {
      fail("index-schema", "seek index invalid");
    }
    if (
      indexResult.data.eventCount !== manifest.eventJournalRef.eventCount ||
      indexResult.data.durationUs !== manifest.durationUs
    ) {
      fail("index-schema", "seek index summary does not match manifest");
    }

    const eventsEntry = handle.entries.get(manifest.eventJournalRef.entry);
    if (!eventsEntry) {
      fail("events-missing", "event journal entry missing");
    }
    if (eventsEntry.uncompressedSize > ARTIFACT_LIMITS.maxEventJournalBytes) {
      fail("events-size", "event journal exceeds size limit");
    }

    const initialExtractedBytes =
      integrityRaw.byteLength + manifestRaw.byteLength + indexRaw.byteLength;
    if (initialExtractedBytes > ARTIFACT_LIMITS.maxTotalExtractedBytes) {
      fail("total-size", "total extracted size limit exceeded");
    }
    return new ArtifactReader(
      handle,
      manifest,
      indexResult.data as SeekIndexV1,
      {
        ...manifest.integrity.entries,
        [ARCHIVE_ENTRIES.manifest]: manifestHash,
      },
      initialExtractedBytes,
    );
  } catch (error) {
    handle.zipfile.close();
    throw error;
  }
}
