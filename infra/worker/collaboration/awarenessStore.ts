import type { Redis } from "@upstash/redis";
import {
  collaborationAwarenessChannel,
  collaborationAwarenessEventSchema,
  collaborationControlChannel,
  collaborationControlEventSchema,
  type CollaborationAwarenessEvent,
  type CollaborationControlEvent,
} from "../../../src/collaboration/protocol";

const AWARENESS_TTL_SECONDS = 45;
const AWARENESS_STREAM_TTL_SECONDS = 10 * 60;
const AWARENESS_STREAM_MAX_LENGTH = 500;
const CONTROL_STREAM_TTL_SECONDS = 24 * 60 * 60;
const CONTROL_STREAM_MAX_LENGTH = 200;
const MAX_AWARENESS_UPDATES_PER_SECOND = 20;

export class CollaborationAwarenessRateLimitError extends Error {
  constructor() {
    super("collaboration awareness rate limit exceeded");
    this.name = "CollaborationAwarenessRateLimitError";
  }
}

function rosterKey(roomId: string): string {
  return `collab:${roomId}:presence-sessions`;
}

function presenceKey(roomId: string, actorId: string, sessionId: string): string {
  return `collab:${roomId}:presence:${actorId}:${sessionId}`;
}

function rosterMember(actorId: string, sessionId: string): string {
  return `${actorId}.${sessionId}`;
}

function rateLimitKey(roomId: string, actorId: string, sessionId: string): string {
  return `collab:${roomId}:presence-rate:${actorId}:${sessionId}:${Math.floor(Date.now() / 1000)}`;
}

async function enforceAwarenessRateLimit(
  redis: Redis,
  roomId: string,
  actorId: string,
  sessionId: string,
): Promise<void> {
  const key = rateLimitKey(roomId, actorId, sessionId);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 2);
  if (count > MAX_AWARENESS_UPDATES_PER_SECOND) {
    throw new CollaborationAwarenessRateLimitError();
  }
}

async function emitAwarenessEvent(
  redis: Redis,
  event: CollaborationAwarenessEvent,
): Promise<string> {
  const channel = collaborationAwarenessChannel(event.roomId);
  const streamId = await redis.xadd(
    channel,
    "*",
    { data: event, event: "awareness.state", channel },
    {
      trim: {
        type: "MAXLEN",
        comparison: "=",
        threshold: AWARENESS_STREAM_MAX_LENGTH,
      },
    },
  );
  if (!streamId) throw new Error("Redis did not assign an awareness stream ID");
  const pipeline = redis.pipeline();
  pipeline.expire(channel, AWARENESS_STREAM_TTL_SECONDS);
  pipeline.publish(channel, {
    data: event,
    event: "awareness.state",
    channel,
    id: streamId,
  });
  await pipeline.exec();
  return streamId;
}

export async function publishCollaborationAwareness(
  redis: Redis,
  event: CollaborationAwarenessEvent,
): Promise<string> {
  const parsed = collaborationAwarenessEventSchema.parse(event);
  await enforceAwarenessRateLimit(redis, parsed.roomId, parsed.actorId, parsed.sessionId);
  if (parsed.kind === "leave") {
    await redis.del(presenceKey(parsed.roomId, parsed.actorId, parsed.sessionId));
    await redis.srem(rosterKey(parsed.roomId), rosterMember(parsed.actorId, parsed.sessionId));
    return emitAwarenessEvent(redis, parsed);
  }

  const pipeline = redis.pipeline();
  pipeline.set(presenceKey(parsed.roomId, parsed.actorId, parsed.sessionId), parsed, {
    ex: AWARENESS_TTL_SECONDS,
  });
  pipeline.sadd(rosterKey(parsed.roomId), rosterMember(parsed.actorId, parsed.sessionId));
  pipeline.expire(rosterKey(parsed.roomId), AWARENESS_STREAM_TTL_SECONDS);
  await pipeline.exec();
  return emitAwarenessEvent(redis, parsed);
}

export async function listCollaborationAwareness(
  redis: Redis,
  roomId: string,
): Promise<CollaborationAwarenessEvent[]> {
  const sessionIds = await redis.smembers(rosterKey(roomId));
  const rosterMembers = sessionIds.slice(0, 50).map(String);
  const values = await Promise.all(
    rosterMembers.map((member) => {
      const separator = member.indexOf(".");
      const actorId = separator < 0 ? "" : member.slice(0, separator);
      const sessionId = separator < 0 ? "" : member.slice(separator + 1);
      return actorId && sessionId
        ? redis.get<unknown>(presenceKey(roomId, actorId, sessionId))
        : Promise.resolve(null);
    }),
  );
  const events: CollaborationAwarenessEvent[] = [];
  const staleSessions: string[] = [];
  const now = Date.now();
  values.forEach((value, index) => {
    const parsed = collaborationAwarenessEventSchema.safeParse(value);
    const sessionId = rosterMembers[index];
    if (!parsed.success || parsed.data.kind !== "state" || parsed.data.expiresAt <= now) {
      staleSessions.push(sessionId);
      return;
    }
    events.push(parsed.data);
  });
  if (staleSessions.length > 0) await redis.srem(rosterKey(roomId), ...staleSessions);
  return events;
}

export async function publishCollaborationControl(
  redis: Redis,
  event: CollaborationControlEvent,
): Promise<string> {
  const parsed = collaborationControlEventSchema.parse(event);
  const channel = collaborationControlChannel(parsed.roomId);
  const streamId = await redis.xadd(
    channel,
    "*",
    { data: parsed, event: "control.room", channel },
    {
      trim: {
        type: "MAXLEN",
        comparison: "=",
        threshold: CONTROL_STREAM_MAX_LENGTH,
      },
    },
  );
  if (!streamId) throw new Error("Redis did not assign a control stream ID");
  const pipeline = redis.pipeline();
  pipeline.expire(channel, CONTROL_STREAM_TTL_SECONDS);
  pipeline.publish(channel, {
    data: parsed,
    event: "control.room",
    channel,
    id: streamId,
  });
  await pipeline.exec();
  return streamId;
}

export const COLLABORATION_AWARENESS_TTL_MS = AWARENESS_TTL_SECONDS * 1000;
