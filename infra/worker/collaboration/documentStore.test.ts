import { describe, expect, it } from "vitest";
import type { Redis } from "@upstash/redis";
import * as Y from "yjs";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  collaborationDocumentUpdateEventSchema,
} from "../../../src/collaboration/protocol";
import {
  applyEncodedYjsSnapshot,
  applyEncodedYjsUpdate,
  createCollaborationDocumentUpdate,
  encodeYjsDocument,
} from "../../../src/collaboration/yjsUpdates";
import {
  appendCollaborationUpdate,
  compactCollaborationDocument,
  getCollaborationBootstrap,
  initializeCollaborationDocument,
} from "./documentStore";

class MemoryRedis {
  readonly values = new Map<string, unknown>();
  readonly streams = new Map<string, Map<string, Record<string, unknown>>>();
  readonly published: Array<{ channel: string; message: unknown }> = [];
  private sequence = 0;

  async set(key: string, value: unknown, options?: { nx?: boolean }) {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return "OK";
  }

  async get<T>(key: string): Promise<T | null> {
    return (structuredClone(this.values.get(key)) as T | undefined) ?? null;
  }

  async del(...keys: string[]) {
    let removed = 0;
    for (const key of keys) removed += this.values.delete(key) ? 1 : 0;
    return removed;
  }

  async incr(key: string) {
    const next = Number(this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return next;
  }

  async xadd(key: string, _id: string, value: Record<string, unknown>) {
    const id = `${++this.sequence}-0`;
    const stream = this.streams.get(key) ?? new Map();
    stream.set(id, structuredClone(value));
    this.streams.set(key, stream);
    return id;
  }

  async publish(channel: string, message: unknown) {
    this.published.push({ channel, message: structuredClone(message) });
    return 1;
  }

  async xrange<T>(key: string, start: string, end: string, count = 1000) {
    const exclusive = start.startsWith("(");
    const normalizedStart = exclusive ? start.slice(1) : start;
    const entries = Array.from(this.streams.get(key)?.entries() ?? []).filter(([id]) => {
      const afterStart = normalizedStart === "-" || (exclusive ? id > normalizedStart : id >= normalizedStart);
      return afterStart && (end === "+" || id <= end);
    });
    return Object.fromEntries(entries.slice(0, count)) as Record<string, T>;
  }

  async xrevrange<T>(key: string, _end: string, _start: string, count = 1000) {
    const entries = Array.from(this.streams.get(key)?.entries() ?? []).reverse().slice(0, count);
    return Object.fromEntries(entries) as Record<string, T>;
  }

  async xtrim(key: string, options: { threshold: string | number }) {
    const stream = this.streams.get(key);
    if (!stream) return 0;
    let removed = 0;
    for (const id of stream.keys()) {
      if (id < String(options.threshold)) {
        stream.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  pipeline() {
    const operations: Array<() => Promise<unknown>> = [];
    return {
      set: (key: string, value: unknown) => {
        operations.push(() => this.set(key, value));
        return this;
      },
      exec: async () => Promise.all(operations.map((operation) => operation())),
    };
  }

  async eval(_script: string, keys: string[], args: string[]) {
    if (this.values.get(keys[0]) === args[0]) return this.del(keys[0]);
    return 0;
  }
}

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const CLIENT_ID = "20000000-0000-4000-8000-000000000001";
const ACTOR_ID = "30000000-0000-4000-8000-000000000001";

function redis(fake: MemoryRedis): Redis {
  return fake as unknown as Redis;
}

function event(update: Uint8Array, updateId: string) {
  return collaborationDocumentUpdateEventSchema.parse({
    ...createCollaborationDocumentUpdate(update, CLIENT_ID, updateId),
    roomId: ROOM_ID,
    actorId: ACTOR_ID,
    receivedAt: 1,
  });
}

describe("collaboration Redis document store", () => {
  it("bootstraps from a snapshot and a paged durable update tail", async () => {
    const fake = new MemoryRedis();
    const initial = new Y.Doc();
    initial.getText("source").insert(0, "start");
    await initializeCollaborationDocument(redis(fake), ROOM_ID, encodeYjsDocument(initial));

    const changed = new Y.Doc();
    applyEncodedYjsSnapshot(changed, encodeYjsDocument(initial));
    changed.getText("source").insert(5, "-next");
    const update = Y.encodeStateAsUpdate(changed, Y.encodeStateVector(initial));
    await appendCollaborationUpdate(
      redis(fake),
      event(update, "40000000-0000-4000-8000-000000000001"),
    );

    const bootstrap = await getCollaborationBootstrap(redis(fake), ROOM_ID);
    expect(bootstrap.protocolVersion).toBe(COLLABORATION_PROTOCOL_VERSION);
    expect(bootstrap.documentSchemaVersion).toBe(COLLABORATION_DOCUMENT_SCHEMA_VERSION);
    expect(bootstrap.updates).toHaveLength(1);
    const restored = new Y.Doc();
    applyEncodedYjsSnapshot(restored, bootstrap.snapshot.update);
    for (const tail of bootstrap.updates) applyEncodedYjsUpdate(restored, tail.event.update);
    expect(restored.getText("source").toString()).toBe("start-next");
  });

  it("deduplicates retried update IDs and republishes the persisted event", async () => {
    const fake = new MemoryRedis();
    const doc = new Y.Doc();
    doc.getText("source").insert(0, "start");
    await initializeCollaborationDocument(redis(fake), ROOM_ID, encodeYjsDocument(doc));
    const update = event(
      Y.encodeStateAsUpdate(doc),
      "40000000-0000-4000-8000-000000000002",
    );

    const first = await appendCollaborationUpdate(redis(fake), update);
    const second = await appendCollaborationUpdate(redis(fake), update);
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ duplicate: true, streamId: first.streamId });
    expect(Array.from(fake.streams.values())[0]).toHaveLength(1);
    expect(fake.published).toHaveLength(2);
  });

  it("compacts an immutable update cutoff into the next snapshot generation", async () => {
    const fake = new MemoryRedis();
    const initial = new Y.Doc();
    initial.getText("source").insert(0, "a");
    await initializeCollaborationDocument(redis(fake), ROOM_ID, encodeYjsDocument(initial));

    const changed = new Y.Doc();
    applyEncodedYjsSnapshot(changed, encodeYjsDocument(initial));
    changed.getText("source").insert(1, "b");
    await appendCollaborationUpdate(
      redis(fake),
      event(
        Y.encodeStateAsUpdate(changed, Y.encodeStateVector(initial)),
        "40000000-0000-4000-8000-000000000003",
      ),
    );

    expect(await compactCollaborationDocument(redis(fake), ROOM_ID)).toMatchObject({
      compacted: true,
      generation: 2,
    });
    const bootstrap = await getCollaborationBootstrap(redis(fake), ROOM_ID);
    expect(bootstrap.snapshot.generation).toBe(2);
    expect(bootstrap.updates).toEqual([]);
    const restored = new Y.Doc();
    applyEncodedYjsSnapshot(restored, bootstrap.snapshot.update);
    expect(restored.getText("source").toString()).toBe("ab");
  });
});
