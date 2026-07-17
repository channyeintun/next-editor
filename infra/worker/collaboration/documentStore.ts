import type { Redis } from "@upstash/redis";
import * as Y from "yjs";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  collaborationDocumentUpdateEventSchema,
  collaborationRoomChannel,
  encodedYjsSnapshotSchema,
  type CollaborationBootstrapResponse,
  type CollaborationDocumentUpdateEvent,
} from "../../../src/collaboration/protocol";
import {
  applyEncodedYjsSnapshot,
  applyEncodedYjsUpdate,
  encodeYjsDocument,
} from "../../../src/collaboration/yjsUpdates";

const BOOTSTRAP_PAGE_SIZE = 100;
const MAX_COMPACTION_UPDATES = 10_000;
const COMPACTION_EVERY_UPDATES = 200;
const DEDUPLICATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const COMPACTION_LOCK_SECONDS = 60;
const MAX_COLLABORATION_ROOM_ACCEPTED_BYTES = 64 * 1024 * 1024;

export class CollaborationDocumentQuotaError extends Error {
  constructor() {
    super("collaboration room document byte quota exceeded");
    this.name = "CollaborationDocumentQuotaError";
  }
}

interface CollaborationSnapshotMetadata {
  generation: number;
  streamCutoff: string;
  protocolVersion: number;
  documentSchemaVersion: number;
  updatedAt: number;
}

interface StoredRealtimeMessage {
  [key: string]: unknown;
  data: unknown;
  event: unknown;
  channel: unknown;
}

function snapshotKey(roomId: string): string {
  return `collab:${roomId}:snapshot`;
}

function snapshotMetadataKey(roomId: string): string {
  return `collab:${roomId}:snapshot-meta`;
}

function updateDeduplicationKey(roomId: string, updateId: string): string {
  return `collab:${roomId}:update:${updateId}`;
}

function updateCountKey(roomId: string): string {
  return `collab:${roomId}:update-count`;
}

function acceptedBytesKey(roomId: string): string {
  return `collab:${roomId}:accepted-bytes`;
}

function compactionLockKey(roomId: string): string {
  return `collab:${roomId}:compaction-lock`;
}

function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

async function reserveAcceptedBytes(redis: Redis, roomId: string, bytes: number): Promise<void> {
  const result = await redis.eval(
    `-- collaboration-byte-quota
     local current = tonumber(redis.call("get", KEYS[1]) or "0")
     local next = current + tonumber(ARGV[1])
     if next > tonumber(ARGV[2]) then return -1 end
     redis.call("set", KEYS[1], next)
     return next`,
    [acceptedBytesKey(roomId)],
    [String(bytes), String(MAX_COLLABORATION_ROOM_ACCEPTED_BYTES)],
  );
  if (Number(result) < 0) throw new CollaborationDocumentQuotaError();
}

function parseSnapshotMetadata(value: unknown): CollaborationSnapshotMetadata {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as CollaborationSnapshotMetadata).generation !== "number" ||
    typeof (value as CollaborationSnapshotMetadata).streamCutoff !== "string" ||
    (value as CollaborationSnapshotMetadata).protocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
    (value as CollaborationSnapshotMetadata).documentSchemaVersion !==
      COLLABORATION_DOCUMENT_SCHEMA_VERSION
  ) {
    throw new Error("collaboration snapshot metadata is invalid");
  }
  return value as CollaborationSnapshotMetadata;
}

function parseStoredEvent(value: unknown): CollaborationDocumentUpdateEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as StoredRealtimeMessage;
  if (message.event !== "document.update") return null;
  const parsed = collaborationDocumentUpdateEventSchema.safeParse(message.data);
  return parsed.success ? parsed.data : null;
}

export async function initializeCollaborationDocument(
  redis: Redis,
  roomId: string,
  initialUpdate: string,
): Promise<void> {
  encodedYjsSnapshotSchema.parse(initialUpdate);
  const metadata: CollaborationSnapshotMetadata = {
    generation: 1,
    streamCutoff: "0-0",
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
    updatedAt: Date.now(),
  };
  const result = await redis.set(snapshotMetadataKey(roomId), metadata, { nx: true });
  if (result !== "OK") throw new Error("collaboration document already exists");
  try {
    await redis.set(snapshotKey(roomId), initialUpdate);
    await redis.set(updateCountKey(roomId), 0);
    await redis.set(acceptedBytesKey(roomId), decodedBase64ByteLength(initialUpdate));
  } catch (error) {
    await redis.del(
      snapshotMetadataKey(roomId),
      snapshotKey(roomId),
      updateCountKey(roomId),
      acceptedBytesKey(roomId),
    );
    throw error;
  }
}

export interface AppendCollaborationUpdateResult {
  streamId: string;
  updateCount: number;
  duplicate: boolean;
}

async function republishStoredEvent(
  redis: Redis,
  roomId: string,
  streamId: string,
): Promise<boolean> {
  const channel = collaborationRoomChannel(roomId);
  const stored = await redis.xrange<StoredRealtimeMessage>(channel, streamId, streamId, 1);
  const message = stored[streamId];
  if (!message || !parseStoredEvent(message)) return false;
  await redis.publish(channel, { ...message, id: streamId });
  return true;
}

export async function appendCollaborationUpdate(
  redis: Redis,
  event: CollaborationDocumentUpdateEvent,
  options: { publish?: boolean } = {},
): Promise<AppendCollaborationUpdateResult> {
  const parsed = collaborationDocumentUpdateEventSchema.parse(event);
  const shouldPublish = options.publish ?? true;
  const deduplicationKey = updateDeduplicationKey(parsed.roomId, parsed.updateId);
  const reservation = await redis.set(deduplicationKey, "pending", {
    nx: true,
    ex: DEDUPLICATION_TTL_SECONDS,
  });
  if (reservation !== "OK") {
    const storedId = await redis.get<string>(deduplicationKey);
    if (storedId && storedId !== "pending") {
      if (shouldPublish) await republishStoredEvent(redis, parsed.roomId, storedId);
      return {
        streamId: storedId,
        updateCount: (await redis.get<number>(updateCountKey(parsed.roomId))) ?? 0,
        duplicate: true,
      };
    }
    throw new Error("collaboration update with this ID is already being accepted");
  }

  const channel = collaborationRoomChannel(parsed.roomId);
  const acceptedBytes = decodedBase64ByteLength(parsed.update);
  let bytesReserved = false;
  try {
    await reserveAcceptedBytes(redis, parsed.roomId, acceptedBytes);
    bytesReserved = true;
    const streamId = await redis.xadd(channel, "*", {
      data: parsed,
      event: "document.update",
      channel,
    });
    if (!streamId) throw new Error("Redis did not assign a collaboration stream ID");

    // Record the durable ID before fan-out. If publish fails, a normal client
    // retry republishes this already-persisted message instead of appending a
    // duplicate stream entry.
    await redis.set(deduplicationKey, streamId, { ex: DEDUPLICATION_TTL_SECONDS });
    const updateCount = await redis.incr(updateCountKey(parsed.roomId));
    if (shouldPublish) {
      await redis.publish(channel, {
        data: parsed,
        event: "document.update",
        channel,
        id: streamId,
      });
    }
    return { streamId, updateCount, duplicate: false };
  } catch (error) {
    if (bytesReserved) await redis.incrby(acceptedBytesKey(parsed.roomId), -acceptedBytes);
    const storedId = await redis.get<string>(deduplicationKey);
    if (!storedId || storedId === "pending") await redis.del(deduplicationKey);
    throw error;
  }
}

export async function getCollaborationSnapshotGeneration(
  redis: Redis,
  roomId: string,
): Promise<number> {
  return parseSnapshotMetadata(await redis.get<unknown>(snapshotMetadataKey(roomId))).generation;
}

export async function exportCollaborationDocument(
  redis: Redis,
  roomId: string,
): Promise<CollaborationBootstrapResponse> {
  await compactCollaborationDocument(redis, roomId);
  return getCollaborationBootstrap(redis, roomId);
}

export async function deleteCollaborationDocument(redis: Redis, roomId: string): Promise<number> {
  let cursor = 0;
  let deleted = 0;
  for (let page = 0; page < 100; page += 1) {
    const [nextCursor, keys] = await redis.scan(cursor, {
      match: `collab:${roomId}:*`,
      count: 100,
    });
    if (keys.length > 0) deleted += await redis.del(...keys.map(String));
    cursor = Number(nextCursor);
    if (cursor === 0) return deleted;
  }
  throw new Error("collaboration cleanup scan limit exceeded");
}

export function shouldCompactCollaborationDocument(updateCount: number): boolean {
  return updateCount > 0 && updateCount % COMPACTION_EVERY_UPDATES === 0;
}

export async function getCollaborationBootstrap(
  redis: Redis,
  roomId: string,
  requestedCursor?: string,
): Promise<CollaborationBootstrapResponse> {
  const [rawMetadata, snapshot] = await Promise.all([
    redis.get<unknown>(snapshotMetadataKey(roomId)),
    redis.get<string>(snapshotKey(roomId)),
  ]);
  const metadata = parseSnapshotMetadata(rawMetadata);
  if (!snapshot) throw new Error("collaboration snapshot is missing");
  encodedYjsSnapshotSchema.parse(snapshot);

  const cursor = requestedCursor ?? metadata.streamCutoff;
  const channel = collaborationRoomChannel(roomId);
  const rawUpdates = await redis.xrange<StoredRealtimeMessage>(
    channel,
    `(${cursor}`,
    "+",
    BOOTSTRAP_PAGE_SIZE + 1,
  );
  const entries = Object.entries(rawUpdates);
  const page = entries.slice(0, BOOTSTRAP_PAGE_SIZE);
  const updates = page.flatMap(([streamId, message]) => {
    const event = parseStoredEvent(message);
    return event ? [{ streamId, event }] : [];
  });
  const nextCursor = page.at(-1)?.[0] ?? cursor;

  return {
    protocolVersion: metadata.protocolVersion,
    documentSchemaVersion: metadata.documentSchemaVersion,
    snapshot: {
      generation: metadata.generation,
      streamCutoff: metadata.streamCutoff,
      update: snapshot,
    },
    updates,
    nextCursor,
    hasMore: entries.length > BOOTSTRAP_PAGE_SIZE,
  };
}

async function releaseLock(redis: Redis, key: string, value: string): Promise<void> {
  await redis.eval(
    `if redis.call("get", KEYS[1]) == ARGV[1] then
       return redis.call("del", KEYS[1])
     end
     return 0`,
    [key],
    [value],
  );
}

export async function compactCollaborationDocument(
  redis: Redis,
  roomId: string,
  expectedGeneration?: number,
): Promise<{ compacted: boolean; generation?: number; streamCutoff?: string }> {
  const lockKey = compactionLockKey(roomId);
  const lockValue = crypto.randomUUID();
  const acquired = await redis.set(lockKey, lockValue, { nx: true, ex: COMPACTION_LOCK_SECONDS });
  if (acquired !== "OK") return { compacted: false };

  try {
    const [rawMetadata, snapshot, latestEntries] = await Promise.all([
      redis.get<unknown>(snapshotMetadataKey(roomId)),
      redis.get<string>(snapshotKey(roomId)),
      redis.xrevrange<StoredRealtimeMessage>(collaborationRoomChannel(roomId), "+", "-", 1),
    ]);
    const metadata = parseSnapshotMetadata(rawMetadata);
    if (expectedGeneration !== undefined && metadata.generation !== expectedGeneration) {
      return { compacted: false, generation: metadata.generation };
    }
    if (!snapshot) throw new Error("collaboration snapshot is missing");
    const cutoff = Object.keys(latestEntries)[0];
    if (!cutoff || cutoff === metadata.streamCutoff) return { compacted: false };

    const doc = new Y.Doc();
    applyEncodedYjsSnapshot(doc, snapshot, "snapshot-compaction");
    let cursor = metadata.streamCutoff;
    let applied = 0;
    while (cursor !== cutoff) {
      const rawUpdates = await redis.xrange<StoredRealtimeMessage>(
        collaborationRoomChannel(roomId),
        `(${cursor}`,
        cutoff,
        BOOTSTRAP_PAGE_SIZE,
      );
      const entries = Object.entries(rawUpdates);
      if (entries.length === 0) break;
      for (const [streamId, message] of entries) {
        const event = parseStoredEvent(message);
        if (event) {
          applyEncodedYjsUpdate(doc, event.update, "snapshot-compaction");
          applied += 1;
          if (applied > MAX_COMPACTION_UPDATES) {
            throw new Error("collaboration compaction update limit exceeded");
          }
        }
        cursor = streamId;
      }
    }
    if (cursor !== cutoff) throw new Error("collaboration update tail is incomplete");

    const nextSnapshot = encodeYjsDocument(doc);
    const nextMetadata: CollaborationSnapshotMetadata = {
      ...metadata,
      generation: metadata.generation + 1,
      streamCutoff: cutoff,
      updatedAt: Date.now(),
    };
    const pipeline = redis.pipeline();
    pipeline.set(snapshotKey(roomId), nextSnapshot);
    pipeline.set(snapshotMetadataKey(roomId), nextMetadata);
    await pipeline.exec();
    // Keep the cutoff entry itself. Bootstrap starts strictly after it, while
    // retaining one known-good stream entry makes recovery inspection easier.
    await redis.xtrim(collaborationRoomChannel(roomId), {
      strategy: "MINID",
      exactness: "=",
      threshold: cutoff,
    });
    return { compacted: true, generation: nextMetadata.generation, streamCutoff: cutoff };
  } finally {
    await releaseLock(redis, lockKey, lockValue);
  }
}
