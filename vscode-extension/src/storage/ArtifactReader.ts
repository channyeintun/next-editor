import { createHash } from "node:crypto";
import * as yauzl from "yauzl";
import type { SessionEvent } from "../model/events";
import { ARCHIVE_ENTRIES, type ManifestV1 } from "../model/manifest";
import { manifestSchema, seekIndexSchema, validateSessionEventRaw } from "../model/schemas";
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
  private extractedBytes = 0;
  private closed = false;

  constructor(
    private readonly handle: ZipHandle,
    readonly manifest: ManifestV1,
    readonly seekIndex: SeekIndexV1,
    private readonly integrity: Record<string, string>,
  ) {}

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
    this.extractedBytes += entry.uncompressedSize;
    if (this.extractedBytes > ARTIFACT_LIMITS.maxTotalExtractedBytes) {
      fail("total-size", "total extracted size limit exceeded");
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
  async readEvents(): Promise<SessionEvent[]> {
    const buffer = await this.readEntryBuffer(
      this.manifest.eventJournalRef.entry,
      ARTIFACT_LIMITS.maxTotalExtractedBytes,
    );
    this.verifyHash(this.manifest.eventJournalRef.entry, buffer);
    const lines = buffer.toString("utf8").split("\n");
    const events: SessionEvent[] = [];
    let lastTUs = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.trim() === "") {
        continue;
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
    }
    if (events.length !== this.manifest.eventJournalRef.eventCount) {
      fail(
        "events-count",
        `event count ${events.length} != manifest ${this.manifest.eventJournalRef.eventCount}`,
      );
    }
    return events;
  }

  async readCheckpoint(documentId: string, checkpointId: string): Promise<string> {
    const entry = ARCHIVE_ENTRIES.checkpoint(documentId, checkpointId);
    const buffer = await this.readEntryBuffer(entry, ARTIFACT_LIMITS.maxCheckpointBytes);
    this.verifyHash(entry, buffer);
    return buffer.toString("utf8");
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

    const readSmall = (entry: yauzl.Entry, name: string): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        handle.zipfile.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(new ArtifactError("zip-read", `cannot read ${name}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => resolve(Buffer.concat(chunks)));
          stream.on("error", (streamError) =>
            reject(new ArtifactError("zip-read", `${name}: ${streamError.message}`)),
          );
        });
      });

    const integrityRaw = await readSmall(integrityEntry, ARCHIVE_ENTRIES.integrity);
    let integrity: { entries?: Record<string, string> };
    try {
      integrity = JSON.parse(integrityRaw.toString("utf8")) as typeof integrity;
    } catch {
      fail("integrity-json", "integrity.json is not valid JSON");
    }
    if (!integrity.entries || typeof integrity.entries !== "object") {
      fail("integrity-json", "integrity.json has no entries table");
    }

    const manifestRaw = await readSmall(manifestEntry, ARCHIVE_ENTRIES.manifest);
    const manifestHash = createHash("sha256").update(manifestRaw).digest("hex");
    if (integrity.entries[ARCHIVE_ENTRIES.manifest] !== manifestHash) {
      fail("integrity", "manifest.json hash mismatch");
    }

    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestRaw.toString("utf8"));
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

    const indexEntry = handle.entries.get(manifest.seekIndexRef.entry);
    if (!indexEntry) {
      fail("index-missing", "seek index missing");
    }
    if (indexEntry.uncompressedSize > ARTIFACT_LIMITS.maxIndexBytes) {
      fail("index-size", "seek index exceeds size limit");
    }
    const indexRaw = await readSmall(indexEntry, manifest.seekIndexRef.entry);
    const indexHash = createHash("sha256").update(indexRaw).digest("hex");
    if (manifest.integrity.entries[manifest.seekIndexRef.entry] !== indexHash) {
      fail("integrity", "seek index hash mismatch");
    }
    let indexJson: unknown;
    try {
      indexJson = JSON.parse(indexRaw.toString("utf8"));
    } catch {
      fail("index-json", "seek index is not valid JSON");
    }
    const indexResult = seekIndexSchema.safeParse(indexJson);
    if (!indexResult.success) {
      fail("index-schema", "seek index invalid");
    }

    if (!handle.entries.has(manifest.eventJournalRef.entry)) {
      fail("events-missing", "event journal entry missing");
    }

    return new ArtifactReader(handle, manifest, indexResult.data as SeekIndexV1, {
      ...manifest.integrity.entries,
      [ARCHIVE_ENTRIES.manifest]: manifestHash,
    });
  } catch (error) {
    handle.zipfile.close();
    throw error;
  }
}
