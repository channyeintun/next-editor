import type { Redis } from "@upstash/redis";

const MAX_USER_UPDATES_PER_SECOND = 30;
const MAX_ROOM_UPDATES_PER_SECOND = 120;
const MAX_USER_CONNECTIONS_PER_MINUTE = 30;

export class CollaborationRateLimitError extends Error {
  constructor(readonly scope: "update" | "connection") {
    super(`collaboration ${scope} rate limit exceeded`);
    this.name = "CollaborationRateLimitError";
  }
}

async function incrementWindow(redis: Redis, key: string, ttlSeconds: number): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, ttlSeconds);
  return count;
}

export async function enforceCollaborationUpdateRateLimit(
  redis: Redis,
  roomId: string,
  userId: string,
): Promise<void> {
  const second = Math.floor(Date.now() / 1000);
  const [userCount, roomCount] = await Promise.all([
    incrementWindow(redis, `collab:${roomId}:rate:update:user:${userId}:${second}`, 2),
    incrementWindow(redis, `collab:${roomId}:rate:update:room:${second}`, 2),
  ]);
  if (userCount > MAX_USER_UPDATES_PER_SECOND || roomCount > MAX_ROOM_UPDATES_PER_SECOND) {
    throw new CollaborationRateLimitError("update");
  }
}

export async function enforceCollaborationConnectionRateLimit(
  redis: Redis,
  userId: string,
): Promise<void> {
  const minute = Math.floor(Date.now() / 60_000);
  const count = await incrementWindow(
    redis,
    `collab:rate:connection:user:${userId}:${minute}`,
    61,
  );
  if (count > MAX_USER_CONNECTIONS_PER_MINUTE) {
    throw new CollaborationRateLimitError("connection");
  }
}
