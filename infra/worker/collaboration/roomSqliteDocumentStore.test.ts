import { DatabaseSync, type SQLInputValue } from "node:sqlite";
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
import { RoomSqliteDocumentStore, type RoomSqliteStorage } from "./roomSqliteDocumentStore";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000002";
const CLIENT_ID = "30000000-0000-4000-8000-000000000003";
const UPDATE_ID = "40000000-0000-4000-8000-000000000004";

class TestSqliteStorage implements RoomSqliteStorage {
  readonly database = new DatabaseSync(":memory:");
  readonly sql = {
    exec: <Row = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): { toArray(): Row[] } => {
      if (bindings.length === 0 && query.trimStart().startsWith("CREATE TABLE")) {
        this.database.exec(query);
        return { toArray: () => [] };
      }
      const statement = this.database.prepare(query);
      if (statement.columns().length === 0) {
        statement.run(...(bindings as SQLInputValue[]));
        return { toArray: () => [] };
      }
      const rows = statement.all(...(bindings as SQLInputValue[])) as Row[];
      return { toArray: () => rows };
    },
  };

  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const openDatabases: TestSqliteStorage[] = [];

afterEach(() => {
  for (const storage of openDatabases.splice(0)) storage.database.close();
});

function createStore(): { storage: TestSqliteStorage; store: RoomSqliteDocumentStore } {
  const storage = new TestSqliteStorage();
  openDatabases.push(storage);
  return { storage, store: new RoomSqliteDocumentStore(storage) };
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
  it("initializes, appends idempotently, and pages from the snapshot cutoff", () => {
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
    expect(store.bootstrap()).toMatchObject({
      snapshot: { generation: 1, streamCutoff: "0-0", update: snapshot },
      updates: [{ streamId: "1-0", event }],
      nextCursor: "1-0",
      hasMore: false,
    });
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
    });
    const bootstrap = store.bootstrap("0-0");
    expect(bootstrap.snapshot).toMatchObject({ generation: 2, streamCutoff: "1-0" });
    expect(bootstrap.updates).toEqual([]);
    const restored = new Y.Doc();
    applyEncodedYjsSnapshot(restored, bootstrap.snapshot.update, "test");
    expect(restored.getText("content").toString()).toBe("before-after");
    expect(store.append(updateEvent(Y.encodeStateAsUpdate(source), UPDATE_ID), 400)).toMatchObject({
      streamId: "1-0",
      duplicate: true,
      event: null,
    });
    restored.destroy();
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
    const result = store.replaceSnapshot(encodeYjsDocument(replacement), 128, 300);

    expect(result).toEqual({ generation: 2, streamId: "1-1" });
    expect(store.bootstrap()).toMatchObject({
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
