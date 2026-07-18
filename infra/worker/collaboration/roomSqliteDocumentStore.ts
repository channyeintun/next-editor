import * as Y from "yjs";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  collaborationDocumentUpdateEventSchema,
  encodedYjsSnapshotSchema,
  type CollaborationBootstrapResponse,
  type CollaborationDocumentUpdateEvent,
} from "../../../src/collaboration/protocol";
import {
  applyEncodedYjsSnapshot,
  applyEncodedYjsUpdate,
  decodeYjsUpdate,
  encodeYjsDocument,
} from "../../../src/collaboration/yjsUpdates";

const BOOTSTRAP_PAGE_SIZE = 100;
const MAX_COMPACTION_UPDATES = 10_000;
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

function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
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

  constructor(storage: RoomSqliteStorage) {
    this.storage = storage;
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
    encodedYjsSnapshotSchema.parse(snapshot);
    const snapshotBytes = decodedBase64ByteLength(snapshot);
    if (snapshotBytes > MAX_COLLABORATION_ROOM_ACCEPTED_BYTES) {
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
        snapshot,
        snapshotBytes,
        now,
        now,
      );
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
    snapshot: string,
    acceptedUpdateBytes: number,
    now = Date.now(),
  ): ReplaceRoomSqliteSnapshotResult {
    encodedYjsSnapshotSchema.parse(snapshot);
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
        snapshot,
        acceptedUpdateBytes,
        now,
      );
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
        update: metadata.snapshot,
      },
      updates,
      nextCursor: streamId(nextCursor),
      hasMore: rows.length > BOOTSTRAP_PAGE_SIZE,
    };
  }

  compact(now = Date.now()): CompactRoomSqliteDocumentResult {
    const metadata = this.metadata();
    const rows = this.storage.sql
      .exec<UpdateRow>(
        `SELECT sequence, event_json FROM collaboration_updates
         WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
        metadata.stream_cutoff,
        MAX_COMPACTION_UPDATES + 1,
      )
      .toArray();
    if (rows.length > MAX_COMPACTION_UPDATES) {
      throw new Error("collaboration SQLite compaction update limit exceeded");
    }
    if (rows.length === 0) {
      this.storage.sql.exec(
        "DELETE FROM collaboration_update_deduplication WHERE expires_at <= ?",
        now,
      );
      return {
        compacted: false,
        generation: metadata.generation,
        streamCutoff: streamId(metadata.stream_cutoff),
        appliedUpdates: 0,
      };
    }

    const doc = new Y.Doc();
    try {
      applyEncodedYjsSnapshot(doc, metadata.snapshot, "sqlite-snapshot-compaction");
      for (const row of rows) {
        applyEncodedYjsUpdate(doc, parseEvent(row.event_json).update, "sqlite-update-compaction");
      }
      const snapshot = encodeYjsDocument(doc);
      const cutoff = rows.at(-1)?.sequence ?? metadata.stream_cutoff;
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
           SET generation = ?, stream_cutoff = ?, snapshot = ?, tail_count = 0, updated_at = ?
           WHERE singleton = 1`,
          generation,
          cutoff,
          snapshot,
          now,
        );
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
        appliedUpdates: rows.length,
      };
    } finally {
      doc.destroy();
    }
  }

  exportDocument(now = Date.now()): CollaborationBootstrapResponse {
    this.compact(now);
    return this.bootstrap();
  }

  createDocument(): Y.Doc {
    const metadata = this.metadata();
    const rows = this.storage.sql
      .exec<UpdateRow>(
        `SELECT sequence, event_json FROM collaboration_updates
         WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
        metadata.stream_cutoff,
        MAX_COMPACTION_UPDATES + 1,
      )
      .toArray();
    if (rows.length > MAX_COMPACTION_UPDATES) {
      throw new Error("collaboration SQLite document materialization limit exceeded");
    }
    const doc = new Y.Doc();
    try {
      applyEncodedYjsSnapshot(doc, metadata.snapshot, "sqlite-document-materialization");
      for (const row of rows) {
        applyEncodedYjsUpdate(
          doc,
          parseEvent(row.event_json).update,
          "sqlite-document-materialization",
        );
      }
      return doc;
    } catch (error) {
      doc.destroy();
      throw error;
    }
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
