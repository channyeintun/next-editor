import * as Y from "yjs";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  collaborationDocumentUpdateEventSchema,
  type CollaborationBootstrapResponse,
  type CollaborationDocumentUpdateEvent,
} from "../../../src/collaboration/protocol";
import {
  applyEncodedYjsUpdate,
  decodeYjsSnapshot,
  decodeYjsUpdate,
} from "../../../src/collaboration/yjsUpdates";

const BOOTSTRAP_PAGE_SIZE = 100;
// Updates folded into the snapshot per compaction pass; the room's alarm runs
// another pass while more remain, so a long tail shrinks in bounded steps.
const MAX_COMPACTION_UPDATES = 10_000;
// Tail rows read per query, so materializing never holds the whole tail's
// JSON in memory at once.
const TAIL_PAGE_SIZE = 256;
// SQLite-backed Durable Objects refuse any single string or BLOB over 2 MB,
// so a snapshot is stored as BLOB chunks of at most this size.
const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
// Revisions before chunked snapshots read only collaboration_document.snapshot
// (base64). It is still filled whenever the base64 fits in one value, so a
// rollback can open every room those revisions could have stored.
const LEGACY_SNAPSHOT_MAX_LENGTH = 1_900_000;
const COMPACTION_EVERY_UPDATES = 200;
const DEDUPLICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COLLABORATION_ROOM_ACCEPTED_BYTES = 64 * 1024 * 1024;

interface SqlCursor<Row> {
  toArray(): Row[];
}

export interface RoomSqliteStorage {
  sql: {
    exec<Row = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<Row>;
  };
  transactionSync<T>(callback: () => T): T;
}

interface MetadataRow {
  protocol_version: number;
  document_schema_version: number;
  generation: number;
  stream_cutoff: number;
  snapshot: string;
  accepted_bytes: number;
  update_count: number;
  tail_count: number;
  updated_at: number;
}

interface UpdateRow {
  sequence: number;
  event_json: string;
}

interface DeduplicationRow {
  stream_id: string;
  expires_at: number;
}

export interface AppendRoomSqliteUpdateResult {
  streamId: string;
  updateCount: number;
  duplicate: boolean;
  shouldCompact: boolean;
}

export interface StoredAppendRoomSqliteUpdateResult extends AppendRoomSqliteUpdateResult {
  event: CollaborationDocumentUpdateEvent | null;
}

export interface CompactRoomSqliteDocumentResult {
  compacted: boolean;
  generation: number;
  streamCutoff: string;
  appliedUpdates: number;
  /** More tail updates remain past this pass's batch. */
  hasMore: boolean;
}

export interface ReplaceRoomSqliteSnapshotResult {
  generation: number;
  streamId: string;
}

export class CollaborationRoomSqliteQuotaError extends Error {
  constructor() {
    super("collaboration room document byte quota exceeded");
    this.name = "CollaborationRoomSqliteQuotaError";
  }
}

const BASE64_CHUNK_BYTES = 0x8000;

// Not yjsUpdates' snapshot encoder: that one enforces the 4 MiB limit on
// snapshots clients send, and a stored room may grow past it.
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

function legacySnapshotColumn(snapshot: Uint8Array): string {
  return 4 * Math.ceil(snapshot.byteLength / 3) <= LEGACY_SNAPSHOT_MAX_LENGTH
    ? encodeBase64(snapshot)
    : "";
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function streamId(sequence: number): string {
  return `${sequence}-0`;
}

function sequenceFromStreamId(value: string): number {
  const match = /^(\d+)-0$/.exec(value);
  const sequence = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("collaboration SQLite stream ID is invalid");
  }
  return sequence;
}

function parseCursor(cursor: string | undefined, fallback: number): number {
  if (!cursor) return fallback;
  const match = /^(\d+)-0$/.exec(cursor);
  if (!match) throw new Error("collaboration SQLite cursor is invalid");
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("collaboration SQLite cursor is invalid");
  }
  return Math.max(sequence, fallback);
}

function parseEvent(eventJson: string): CollaborationDocumentUpdateEvent {
  const parsed = collaborationDocumentUpdateEventSchema.safeParse(JSON.parse(eventJson));
  if (!parsed.success) throw new Error("collaboration SQLite update is invalid");
  return parsed.data;
}

export class RoomSqliteDocumentStore {
  private readonly storage: RoomSqliteStorage;
  private readonly compactionBatchSize: number;

  /** `compactionBatchSize` defaults to MAX_COMPACTION_UPDATES; tests shrink it. */
  constructor(storage: RoomSqliteStorage, options: { compactionBatchSize?: number } = {}) {
    this.storage = storage;
    this.compactionBatchSize = options.compactionBatchSize ?? MAX_COMPACTION_UPDATES;
    // collaboration_document.snapshot is the snapshot's base64 when it fits one
    // value (see LEGACY_SNAPSHOT_MAX_LENGTH) and '' otherwise; the snapshot
    // itself lives in collaboration_snapshot_chunks under its generation.
    // Rooms written before chunks existed have only the column.
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_document (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        protocol_version INTEGER NOT NULL,
        document_schema_version INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        stream_cutoff INTEGER NOT NULL,
        snapshot TEXT NOT NULL,
        accepted_bytes INTEGER NOT NULL,
        update_count INTEGER NOT NULL,
        tail_count INTEGER NOT NULL,
        initialized_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collaboration_updates (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS collaboration_snapshot_chunks (
        generation INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        bytes BLOB NOT NULL,
        PRIMARY KEY (generation, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS collaboration_update_deduplication (
        update_id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_collaboration_update_received
        ON collaboration_updates(received_at);
      CREATE INDEX IF NOT EXISTS idx_collaboration_deduplication_expiry
        ON collaboration_update_deduplication(expires_at);
    `);
  }

  initialize(snapshot: string, now = Date.now()): void {
    const snapshotBytes = decodeYjsSnapshot(snapshot);
    if (snapshotBytes.byteLength > MAX_COLLABORATION_ROOM_ACCEPTED_BYTES) {
      throw new CollaborationRoomSqliteQuotaError();
    }

    this.storage.transactionSync(() => {
      const existing = this.storage.sql
        .exec<{ singleton: number }>(
          "SELECT singleton FROM collaboration_document WHERE singleton = 1",
        )
        .toArray()[0];
      if (existing) throw new Error("collaboration document already exists");
      this.storage.sql.exec(
        `INSERT INTO collaboration_document
          (singleton, protocol_version, document_schema_version, generation,
           stream_cutoff, snapshot, accepted_bytes, update_count, tail_count,
           initialized_at, updated_at)
         VALUES (1, ?, ?, 1, 0, ?, ?, 0, 0, ?, ?)`,
        COLLABORATION_PROTOCOL_VERSION,
        COLLABORATION_DOCUMENT_SCHEMA_VERSION,
        legacySnapshotColumn(snapshotBytes),
        snapshotBytes.byteLength,
        now,
        now,
      );
      this.writeSnapshotChunks(1, snapshotBytes);
    });
  }

  append(
    event: CollaborationDocumentUpdateEvent,
    now = Date.now(),
  ): StoredAppendRoomSqliteUpdateResult {
    const parsed = collaborationDocumentUpdateEventSchema.parse(event);
    const decodedUpdate = decodeYjsUpdate(parsed.update);
    // Reject malformed binary before reserving quota or assigning a durable
    // sequence. Missing dependencies are valid Yjs updates and still decode.
    Y.decodeUpdate(decodedUpdate);
    const acceptedBytes = decodedUpdate.byteLength;

    return this.storage.transactionSync(() => {
      const duplicate = this.storage.sql
        .exec<DeduplicationRow>(
          `SELECT stream_id, expires_at
           FROM collaboration_update_deduplication WHERE update_id = ?`,
          parsed.updateId,
        )
        .toArray()[0];
      const metadata = this.metadata();
      if (duplicate && duplicate.expires_at > now) {
        const stored = this.storage.sql
          .exec<UpdateRow>(
            "SELECT sequence, event_json FROM collaboration_updates WHERE sequence = ?",
            sequenceFromStreamId(duplicate.stream_id),
          )
          .toArray()[0];
        return {
          streamId: duplicate.stream_id,
          updateCount: metadata.update_count,
          duplicate: true,
          shouldCompact: metadata.tail_count >= COMPACTION_EVERY_UPDATES,
          // Once compaction has incorporated the update into the snapshot there
          // is no tail event to replay. Before then, retries fan out the exact
          // durable event rather than trusting a changed payload with the same ID.
          event: stored ? parseEvent(stored.event_json) : null,
        };
      }
      if (duplicate) {
        this.storage.sql.exec(
          "DELETE FROM collaboration_update_deduplication WHERE update_id = ?",
          parsed.updateId,
        );
      }
      if (metadata.accepted_bytes + acceptedBytes > MAX_COLLABORATION_ROOM_ACCEPTED_BYTES) {
        throw new CollaborationRoomSqliteQuotaError();
      }

      this.storage.sql.exec(
        `INSERT INTO collaboration_updates
          (update_id, event_json, byte_length, received_at) VALUES (?, ?, ?, ?)`,
        parsed.updateId,
        JSON.stringify(parsed),
        acceptedBytes,
        parsed.receivedAt,
      );
      const inserted = this.storage.sql
        .exec<{ sequence: number }>("SELECT last_insert_rowid() AS sequence")
        .toArray()[0];
      if (!inserted || !Number.isSafeInteger(inserted.sequence)) {
        throw new Error("collaboration SQLite update sequence is invalid");
      }
      const assignedStreamId = streamId(inserted.sequence);
      this.storage.sql.exec(
        `INSERT INTO collaboration_update_deduplication (update_id, stream_id, expires_at)
         VALUES (?, ?, ?)`,
        parsed.updateId,
        assignedStreamId,
        now + DEDUPLICATION_TTL_MS,
      );
      this.storage.sql.exec(
        `UPDATE collaboration_document
         SET accepted_bytes = accepted_bytes + ?, update_count = update_count + 1,
             tail_count = tail_count + 1, updated_at = ?
         WHERE singleton = 1`,
        acceptedBytes,
        now,
      );
      const updateCount = metadata.update_count + 1;
      const tailCount = metadata.tail_count + 1;
      return {
        streamId: assignedStreamId,
        updateCount,
        duplicate: false,
        shouldCompact: tailCount >= COMPACTION_EVERY_UPDATES,
        event: parsed,
      };
    });
  }

  replaceSnapshot(
    snapshot: Uint8Array,
    acceptedUpdateBytes: number,
    now = Date.now(),
  ): ReplaceRoomSqliteSnapshotResult {
    if (!Number.isSafeInteger(acceptedUpdateBytes) || acceptedUpdateBytes < 0) {
      throw new Error("collaboration snapshot update length is invalid");
    }
    return this.storage.transactionSync(() => {
      const metadata = this.metadata();
      if (metadata.accepted_bytes + acceptedUpdateBytes > MAX_COLLABORATION_ROOM_ACCEPTED_BYTES) {
        throw new CollaborationRoomSqliteQuotaError();
      }
      const latest = this.storage.sql
        .exec<{ sequence: number | null }>(
          "SELECT MAX(sequence) AS sequence FROM collaboration_updates",
        )
        .toArray()[0];
      const cutoff = latest?.sequence ?? metadata.stream_cutoff;
      const generation = metadata.generation + 1;
      this.storage.sql.exec(
        `UPDATE collaboration_document
         SET generation = ?, stream_cutoff = ?, snapshot = ?,
             accepted_bytes = accepted_bytes + ?, tail_count = 0, updated_at = ?
         WHERE singleton = 1`,
        generation,
        cutoff,
        legacySnapshotColumn(snapshot),
        acceptedUpdateBytes,
        now,
      );
      this.writeSnapshotChunks(generation, snapshot);
      this.storage.sql.exec("DELETE FROM collaboration_updates WHERE sequence <= ?", cutoff);
      return { generation, streamId: `${cutoff}-1` };
    });
  }

  bootstrap(requestedCursor?: string): CollaborationBootstrapResponse {
    const metadata = this.metadata();
    const cursor = parseCursor(requestedCursor, metadata.stream_cutoff);
    const rows = this.storage.sql
      .exec<UpdateRow>(
        `SELECT sequence, event_json FROM collaboration_updates
         WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
        cursor,
        BOOTSTRAP_PAGE_SIZE + 1,
      )
      .toArray();
    const page = rows.slice(0, BOOTSTRAP_PAGE_SIZE);
    const updates = page.map((row) => ({
      streamId: streamId(row.sequence),
      event: parseEvent(row.event_json),
    }));
    const nextCursor = page.at(-1)?.sequence ?? cursor;

    return {
      protocolVersion: metadata.protocol_version,
      documentSchemaVersion: metadata.document_schema_version,
      snapshot: {
        generation: metadata.generation,
        streamCutoff: streamId(metadata.stream_cutoff),
        update: encodeBase64(this.readSnapshot(metadata)),
      },
      updates,
      nextCursor: streamId(nextCursor),
      hasMore: rows.length > BOOTSTRAP_PAGE_SIZE,
    };
  }

  compact(now = Date.now()): CompactRoomSqliteDocumentResult {
    const metadata = this.metadata();
    if (!this.hasTailAfter(metadata.stream_cutoff)) {
      this.storage.sql.exec(
        "DELETE FROM collaboration_update_deduplication WHERE expires_at <= ?",
        now,
      );
      return {
        compacted: false,
        generation: metadata.generation,
        streamCutoff: streamId(metadata.stream_cutoff),
        appliedUpdates: 0,
        hasMore: false,
      };
    }

    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, this.readSnapshot(metadata), "sqlite-snapshot-compaction");
      const { lastSequence: cutoff, applied } = this.applyTail(
        doc,
        metadata.stream_cutoff,
        this.compactionBatchSize,
        "sqlite-update-compaction",
      );
      const snapshot = Y.encodeStateAsUpdate(doc);
      const generation = metadata.generation + 1;
      this.storage.transactionSync(() => {
        const current = this.metadata();
        if (
          current.generation !== metadata.generation ||
          current.stream_cutoff !== metadata.stream_cutoff
        ) {
          throw new Error("collaboration SQLite compaction generation changed");
        }
        this.storage.sql.exec(
          `UPDATE collaboration_document
           SET generation = ?, stream_cutoff = ?, snapshot = ?,
               tail_count = MAX(tail_count - ?, 0), updated_at = ?
           WHERE singleton = 1`,
          generation,
          cutoff,
          legacySnapshotColumn(snapshot),
          applied,
          now,
        );
        this.writeSnapshotChunks(generation, snapshot);
        this.storage.sql.exec("DELETE FROM collaboration_updates WHERE sequence <= ?", cutoff);
        this.storage.sql.exec(
          "DELETE FROM collaboration_update_deduplication WHERE expires_at <= ?",
          now,
        );
      });
      return {
        compacted: true,
        generation,
        streamCutoff: streamId(cutoff),
        appliedUpdates: applied,
        hasMore: this.hasTailAfter(cutoff),
      };
    } finally {
      doc.destroy();
    }
  }

  exportDocument(now = Date.now()): CollaborationBootstrapResponse {
    // Fold the whole tail into the snapshot, however many passes it takes.
    let result: CompactRoomSqliteDocumentResult;
    do {
      result = this.compact(now);
    } while (result.hasMore);
    return this.bootstrap();
  }

  createDocument(): Y.Doc {
    const metadata = this.metadata();
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, this.readSnapshot(metadata), "sqlite-document-materialization");
      this.applyTail(
        doc,
        metadata.stream_cutoff,
        Number.POSITIVE_INFINITY,
        "sqlite-document-materialization",
      );
      return doc;
    } catch (error) {
      doc.destroy();
      throw error;
    }
  }

  /** The snapshot of `metadata.generation`, from its chunks or the single column. */
  private readSnapshot(metadata: MetadataRow): Uint8Array {
    const chunks = this.storage.sql
      .exec<{ bytes: ArrayBuffer }>(
        `SELECT bytes FROM collaboration_snapshot_chunks
         WHERE generation = ? ORDER BY chunk_index ASC`,
        metadata.generation,
      )
      .toArray();
    // No chunks for this generation: a revision from before chunked snapshots
    // wrote it, either before this one first ran or after a rollback.
    if (chunks.length === 0) return decodeYjsSnapshot(metadata.snapshot);
    const snapshot = new Uint8Array(
      chunks.reduce((total, { bytes }) => total + bytes.byteLength, 0),
    );
    let offset = 0;
    for (const { bytes } of chunks) {
      snapshot.set(new Uint8Array(bytes), offset);
      offset += bytes.byteLength;
    }
    return snapshot;
  }

  /** Stores `snapshot` as `generation`'s chunks and drops every other generation's. */
  private writeSnapshotChunks(generation: number, snapshot: Uint8Array): void {
    for (let index = 0; index * SNAPSHOT_CHUNK_BYTES < snapshot.byteLength; index += 1) {
      const offset = index * SNAPSHOT_CHUNK_BYTES;
      this.storage.sql.exec(
        `INSERT INTO collaboration_snapshot_chunks (generation, chunk_index, bytes)
         VALUES (?, ?, ?)`,
        generation,
        index,
        exactArrayBuffer(snapshot.subarray(offset, offset + SNAPSHOT_CHUNK_BYTES)),
      );
    }
    this.storage.sql.exec(
      "DELETE FROM collaboration_snapshot_chunks WHERE generation <> ?",
      generation,
    );
  }

  private hasTailAfter(sequence: number): boolean {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM collaboration_updates WHERE sequence > ? LIMIT 1", sequence)
        .toArray().length > 0
    );
  }

  /** Applies up to `limit` tail updates after `afterSequence`, a page at a time. */
  private applyTail(
    doc: Y.Doc,
    afterSequence: number,
    limit: number,
    origin: string,
  ): { lastSequence: number; applied: number } {
    let lastSequence = afterSequence;
    let applied = 0;
    while (applied < limit) {
      const page = this.storage.sql
        .exec<UpdateRow>(
          `SELECT sequence, event_json FROM collaboration_updates
           WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
          lastSequence,
          Math.min(TAIL_PAGE_SIZE, limit - applied),
        )
        .toArray();
      for (const row of page) {
        applyEncodedYjsUpdate(doc, parseEvent(row.event_json).update, origin);
        lastSequence = row.sequence;
      }
      applied += page.length;
      if (page.length < TAIL_PAGE_SIZE) break;
    }
    return { lastSequence, applied };
  }

  private metadata(): MetadataRow {
    const row = this.storage.sql
      .exec<MetadataRow>("SELECT * FROM collaboration_document WHERE singleton = 1")
      .toArray()[0];
    if (!row) throw new Error("collaboration SQLite document is not initialized");
    if (
      row.protocol_version !== COLLABORATION_PROTOCOL_VERSION ||
      row.document_schema_version !== COLLABORATION_DOCUMENT_SCHEMA_VERSION
    ) {
      throw new Error("collaboration SQLite document metadata is invalid");
    }
    return row;
  }
}
