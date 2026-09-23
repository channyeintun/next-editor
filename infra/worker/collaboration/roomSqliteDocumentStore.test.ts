import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  type CollaborationDocumentUpdateEvent,
} from "../../../src/collaboration/protocol";
import {
  applyEncodedYjsSnapshot,
  encodeYjsDocument,
  encodeYjsUpdate,
} from "../../../src/collaboration/yjsUpdates";
import { SqliteTestStorage } from "../testing/sqliteStorage";
import { RoomSqliteDocumentStore } from "./roomSqliteDocumentStore";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000002";
const CLIENT_ID = "30000000-0000-4000-8000-000000000003";
const UPDATE_ID = "40000000-0000-4000-8000-000000000004";

const openDatabases: SqliteTestStorage[] = [];

afterEach(() => {
  for (const storage of openDatabases.splice(0)) storage.close();
});

function createStore(options: { compactionBatchSize?: number } = {}): {
  storage: SqliteTestStorage;
  store: RoomSqliteDocumentStore;
} {
  const storage = new SqliteTestStorage();
  openDatabases.push(storage);
  return { storage, store: new RoomSqliteDocumentStore(storage, options) };
}

let nextUpdate = 100;

/** Appends `text` to `source` and stores that change as the next update. */
function appendEdit(store: RoomSqliteDocumentStore, source: Y.Doc, text: string): void {
  const before = Y.encodeStateVector(source);
  source.getText("content").insert(source.getText("content").length, text);
  const updateId = `40000000-0000-4000-8000-${String(nextUpdate++).padStart(12, "0")}`;
  store.append(updateEvent(Y.encodeStateAsUpdate(source, before), updateId), 200);
}

function snapshotText(snapshot: string): string {
  const doc = new Y.Doc();
  applyEncodedYjsSnapshot(doc, snapshot, "test");
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}

function materializedText(store: RoomSqliteDocumentStore): string {
  const doc = store.createDocument();
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}

/** Deterministic text Yjs cannot shrink, about one byte per character. */
function filler(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let block = "";
  for (let index = 0; index < 4096; index += 1) {
    block += alphabet[(index * 7919 + (index >> 5)) % alphabet.length];
  }
  return block.repeat(Math.ceil(length / block.length)).slice(0, length);
}

function updateEvent(update: Uint8Array, updateId = UPDATE_ID): CollaborationDocumentUpdateEvent {
  return {
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
    clientId: CLIENT_ID,
    updateId,
    update: encodeYjsUpdate(update),
    roomId: ROOM_ID,
    actorId: ACTOR_ID,
    receivedAt: 1_000,
  };
}

describe("RoomSqliteDocumentStore", () => {
  it("initializes and appends idempotently", () => {
    const { store } = createStore();
    const source = new Y.Doc();
    source.getText("content").insert(0, "a");
    const snapshot = encodeYjsDocument(source);
    const stateVector = Y.encodeStateVector(source);
    source.getText("content").insert(1, "b");
    const event = updateEvent(Y.encodeStateAsUpdate(source, stateVector));
    store.initialize(snapshot, 100);

    const appended = store.append(event, 200);
    const duplicate = store.append(event, 300);
    expect(appended).toMatchObject({ streamId: "1-0", updateCount: 1, duplicate: false });
    expect(duplicate).toMatchObject({
      streamId: "1-0",
      updateCount: 1,
      duplicate: true,
      event,
    });
    expect(materializedText(store)).toBe("ab");
    source.destroy();
  });

  it("compacts the update tail into a new Yjs snapshot", () => {
    const { store } = createStore();
    const source = new Y.Doc();
    source.getText("content").insert(0, "before");
    store.initialize(encodeYjsDocument(source), 100);
    const stateVector = Y.encodeStateVector(source);
    source.getText("content").insert(6, "-after");
    store.append(updateEvent(Y.encodeStateAsUpdate(source, stateVector)), 200);

    expect(store.compact(300)).toEqual({
      compacted: true,
      generation: 2,
      streamCutoff: "1-0",
      appliedUpdates: 1,
      hasMore: false,
    });
    const exported = store.exportDocument(350);
    expect(exported).toMatchObject({
      snapshot: { generation: 2, streamCutoff: "1-0" },
      updates: [],
      nextCursor: "1-0",
      hasMore: false,
    });
    expect(snapshotText(exported.snapshot.update)).toBe("before-after");
    expect(store.append(updateEvent(Y.encodeStateAsUpdate(source), UPDATE_ID), 400)).toMatchObject({
      streamId: "1-0",
      duplicate: true,
      event: null,
    });
    source.destroy();
  });

  it("materializes the compacted snapshot plus current update tail", () => {
    const { store } = createStore();
    const source = new Y.Doc();
    source.getText("content").insert(0, "a");
    store.initialize(encodeYjsDocument(source), 100);
    let stateVector = Y.encodeStateVector(source);
    source.getText("content").insert(1, "b");
    store.append(updateEvent(Y.encodeStateAsUpdate(source, stateVector)), 200);
    store.compact(300);
    stateVector = Y.encodeStateVector(source);
    source.getText("content").insert(2, "c");
    store.append(
      updateEvent(
        Y.encodeStateAsUpdate(source, stateVector),
        "50000000-0000-4000-8000-000000000005",
      ),
      400,
    );

    const materialized = store.createDocument();
    expect(materialized.getText("content").toString()).toBe("abc");
    materialized.destroy();
    source.destroy();
  });

  it("replaces the snapshot atomically while retaining the current update tail", () => {
    const { store } = createStore();
    const source = new Y.Doc();
    source.getText("content").insert(0, "a");
    store.initialize(encodeYjsDocument(source), 100);
    const stateVector = Y.encodeStateVector(source);
    source.getText("content").insert(1, "b");
    const tailEvent = updateEvent(Y.encodeStateAsUpdate(source, stateVector));
    store.append(tailEvent, 200);

    const replacement = store.createDocument();
    replacement.getMap("project").set("teachingInitialized", true);
    const result = store.replaceSnapshot(Y.encodeStateAsUpdate(replacement), 128, 300);

    expect(result).toEqual({ generation: 2, streamId: "1-1" });
    expect(store.exportDocument(350)).toMatchObject({
      snapshot: { generation: 2, streamCutoff: "1-0" },
      updates: [],
      nextCursor: "1-0",
    });
    const restored = store.createDocument();
    expect(restored.getText("content").toString()).toBe("ab");
    expect(restored.getMap("project").get("teachingInitialized")).toBe(true);
    expect(store.append(tailEvent, 400)).toMatchObject({
      streamId: "1-0",
      duplicate: true,
      event: null,
    });

    restored.destroy();
    replacement.destroy();
    source.destroy();
  });
});

describe("RoomSqliteDocumentStore snapshot chunks", () => {
  // Durable Object SQLite refuses any one value over 2 MB (SqliteTestStorage
  // enforces it). 1.7 MB of text encodes to about 2.3 MB of base64, over that
  // limit and within the 4 MiB create limit. Megabytes of Yjs and base64 work
  // are slow when the whole suite shares the CPU, hence the timeout.
  it("stores and compacts a snapshot larger than one SQLite value", { timeout: 30_000 }, () => {
    const { storage, store } = createStore();
    const source = new Y.Doc();
    source.getText("content").insert(0, filler(1_700_000));
    store.initialize(encodeYjsDocument(source), 100);
    appendEdit(store, source, "-edited");

    expect(store.compact(300)).toMatchObject({ compacted: true, generation: 2, hasMore: false });
    expect(materializedText(store)).toBe(source.getText("content").toString());
    expect(snapshotText(store.exportDocument(400).snapshot.update)).toBe(
      source.getText("content").toString(),
    );
    const [row] = storage.sql
      .exec<{ snapshot: string }>("SELECT snapshot FROM collaboration_document")
      .toArray();
    expect(row?.snapshot).toBe("");
    source.destroy();
  });

  it("keeps the single snapshot column readable for a rollback while it fits", () => {
    const { storage, store } = createStore();
    const source = new Y.Doc();
    source.getText("content").insert(0, "before");
    store.initialize(encodeYjsDocument(source), 100);
    appendEdit(store, source, "-after");
    store.compact(300);

    const [row] = storage.sql
      .exec<{ snapshot: string }>("SELECT snapshot FROM collaboration_document")
      .toArray();
    expect(snapshotText(row?.snapshot ?? "")).toBe("before-after");
    source.destroy();
  });
});

describe("RoomSqliteDocumentStore rooms saved before snapshot chunks", () => {
  /** A room as earlier revisions stored it: the snapshot only in the TEXT column. */
  function createLegacyRoom(text: string) {
    const created = createStore();
    const source = new Y.Doc();
    source.getText("content").insert(0, text);
    created.storage.sql.exec(
      `INSERT INTO collaboration_document
        (singleton, protocol_version, document_schema_version, generation,
         stream_cutoff, snapshot, accepted_bytes, update_count, tail_count,
         initialized_at, updated_at)
       VALUES (1, ?, ?, 1, 0, ?, 0, 0, 0, 100, 100)`,
      COLLABORATION_PROTOCOL_VERSION,
      COLLABORATION_DOCUMENT_SCHEMA_VERSION,
      encodeYjsDocument(source),
    );
    return { ...created, source };
  }

  function chunkGenerations(storage: SqliteTestStorage): number[] {
    return storage.sql
      .exec<{ generation: number }>(
        "SELECT DISTINCT generation FROM collaboration_snapshot_chunks ORDER BY generation",
      )
      .toArray()
      .map((row) => row.generation);
  }

  it("loads a single-column room and moves it to chunks when it is compacted", () => {
    const { storage, store, source } = createLegacyRoom("before");
    appendEdit(store, source, "-after");

    expect(materializedText(store)).toBe("before-after");
    expect(chunkGenerations(storage)).toEqual([]);

    expect(store.compact(300)).toMatchObject({ compacted: true, generation: 2 });
    expect(chunkGenerations(storage)).toEqual([2]);
    expect(materializedText(store)).toBe("before-after");
    appendEdit(store, source, "-again");
    expect(snapshotText(store.exportDocument(400).snapshot.update)).toBe("before-after-again");
    source.destroy();
  });

  it("reads the single column when an earlier revision saved a newer generation", () => {
    const { storage, store, source } = createLegacyRoom("before");
    appendEdit(store, source, "-after");
    store.compact(300);
    // After a rollback, an earlier revision compacts again: it writes only the
    // column and leaves this revision's generation-2 chunks behind.
    source.getText("content").insert(source.getText("content").length, "-rolled-back");
    storage.sql.exec(
      "UPDATE collaboration_document SET generation = 3, snapshot = ? WHERE singleton = 1",
      encodeYjsDocument(source),
    );

    expect(materializedText(store)).toBe("before-after-rolled-back");
    source.destroy();
  });
});

describe("RoomSqliteDocumentStore compaction batches", () => {
  it("folds a tail longer than one batch in several passes", () => {
    const { store } = createStore({ compactionBatchSize: 3 });
    const source = new Y.Doc();
    source.getText("content").insert(0, "0");
    store.initialize(encodeYjsDocument(source), 100);
    for (let index = 1; index <= 7; index += 1) appendEdit(store, source, String(index));

    expect(materializedText(store)).toBe("01234567");
    expect(store.compact(300)).toMatchObject({ appliedUpdates: 3, hasMore: true });
    expect(store.compact(300)).toMatchObject({ appliedUpdates: 3, hasMore: true });
    expect(store.compact(300)).toMatchObject({ appliedUpdates: 1, hasMore: false });
    expect(materializedText(store)).toBe("01234567");
    source.destroy();
  });

  it("exports the whole tail when it spans several batches", () => {
    const { store } = createStore({ compactionBatchSize: 2 });
    const source = new Y.Doc();
    source.getText("content").insert(0, "0");
    store.initialize(encodeYjsDocument(source), 100);
    for (let index = 1; index <= 5; index += 1) appendEdit(store, source, String(index));

    const exported = store.exportDocument(300);
    expect(snapshotText(exported.snapshot.update)).toBe("012345");
    expect(exported.updates).toEqual([]);
    source.destroy();
  });
});

describe("RoomSqliteDocumentStore schema", () => {
  it("drops the update index on received_at, which no query uses", () => {
    const { storage } = createStore();
    // Rooms created by earlier revisions carry it.
    storage.sql.exec(
      "CREATE INDEX idx_collaboration_update_received ON collaboration_updates(received_at)",
    );

    new RoomSqliteDocumentStore(storage);

    const indexes = storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'collaboration_updates'",
      )
      .toArray()
      .map((row) => row.name);
    expect(indexes).not.toContain("idx_collaboration_update_received");
  });
});
