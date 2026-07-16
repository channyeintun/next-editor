import type { Redis } from "@upstash/redis";
import { describe, expect, it } from "vitest";
import {
  collaborationAwarenessChannel,
  collaborationControlChannel,
} from "../../../src/collaboration/protocol";
import {
  listCollaborationAwareness,
  publishCollaborationAwareness,
  publishCollaborationControl,
} from "./awarenessStore";

class MemoryRedis {
  readonly values = new Map<string, unknown>();
  readonly sets = new Map<string, Set<string>>();
  readonly streams = new Map<string, Map<string, Record<string, unknown>>>();
  readonly published: Array<{ channel: string; message: unknown }> = [];
  private sequence = 0;

  async set(key: string, value: unknown) {
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

  async expire(_key: string, _seconds: number) {
    return 1;
  }

  async sadd(key: string, ...members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const member of members) set.add(member);
    this.sets.set(key, set);
    return members.length;
  }

  async srem(key: string, ...members: string[]) {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) removed += set.delete(member) ? 1 : 0;
    return removed;
  }

  async smembers(key: string) {
    return Array.from(this.sets.get(key) ?? []);
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

  pipeline() {
    const operations: Array<() => Promise<unknown>> = [];
    const pipeline = {
      set: (key: string, value: unknown) => {
        operations.push(() => this.set(key, value));
        return pipeline;
      },
      sadd: (key: string, ...members: string[]) => {
        operations.push(() => this.sadd(key, ...members));
        return pipeline;
      },
      expire: (key: string, seconds: number) => {
        operations.push(() => this.expire(key, seconds));
        return pipeline;
      },
      publish: (channel: string, message: unknown) => {
        operations.push(() => this.publish(channel, message));
        return pipeline;
      },
      exec: async () => Promise.all(operations.map((operation) => operation())),
    };
    return pipeline;
  }
}

const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";

function redis(fake: MemoryRedis): Redis {
  return fake as unknown as Redis;
}

function stateEvent() {
  const now = Date.now();
  return {
    kind: "state" as const,
    roomId: ROOM_ID,
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    revision: 1,
    role: "owner" as const,
    username: "host",
    name: "Room Host",
    avatarUrl: null,
    isHost: true,
    activeFileNodeId: null,
    cursor: null,
    followingHost: false,
    occurredAt: now,
    expiresAt: now + 45_000,
  };
}

describe("collaboration awareness store", () => {
  it("lists active sessions and removes an explicit leave", async () => {
    const fake = new MemoryRedis();
    const state = stateEvent();
    await publishCollaborationAwareness(redis(fake), state);

    expect(await listCollaborationAwareness(redis(fake), ROOM_ID)).toEqual([state]);

    await publishCollaborationAwareness(redis(fake), {
      kind: "leave",
      roomId: ROOM_ID,
      actorId: ACTOR_ID,
      sessionId: SESSION_ID,
      revision: 2,
      occurredAt: Date.now(),
    });
    expect(await listCollaborationAwareness(redis(fake), ROOM_ID)).toEqual([]);
  });

  it("keeps awareness and control traffic in independently trimmed streams", async () => {
    const fake = new MemoryRedis();
    await publishCollaborationAwareness(redis(fake), stateEvent());
    await publishCollaborationControl(redis(fake), {
      kind: "room-closed",
      roomId: ROOM_ID,
      roleVersion: 2,
      targetUserId: null,
      occurredAt: Date.now(),
    });

    expect(fake.streams.get(collaborationAwarenessChannel(ROOM_ID))).toHaveLength(1);
    expect(fake.streams.get(collaborationControlChannel(ROOM_ID))).toHaveLength(1);
    expect(collaborationAwarenessChannel(ROOM_ID)).not.toBe(
      collaborationControlChannel(ROOM_ID),
    );
  });

  it("drops expired presence from the roster", async () => {
    const fake = new MemoryRedis();
    const state = stateEvent();
    await publishCollaborationAwareness(redis(fake), state);
    const presenceKey = Array.from(fake.values.keys()).find((key) =>
      key.includes(":presence:"),
    );
    expect(presenceKey).toBeDefined();
    fake.values.set(presenceKey!, { ...state, expiresAt: Date.now() - 1 });

    expect(await listCollaborationAwareness(redis(fake), ROOM_ID)).toEqual([]);
  });
});
