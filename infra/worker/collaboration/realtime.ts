import { Realtime } from "@upstash/realtime";
import { Redis } from "@upstash/redis/cloudflare";
import { collaborationRealtimeSchema } from "../../../src/collaboration/protocol";
import type { Env } from "../env";

const REALTIME_CONNECTION_DURATION_SECONDS = 300;

export class CollaborationConfigurationError extends Error {
  constructor() {
    super("Dedicated collaboration Redis credentials are not configured");
    this.name = "CollaborationConfigurationError";
  }
}

// Collaboration is fail-closed. Unlike the optional gallery cache, an
// accepted document update cannot silently fall back to a different store.
export function getCollaborationRedis(env: Env): Redis {
  if (!env.COLLAB_REDIS_REST_URL || !env.COLLAB_REDIS_REST_TOKEN) {
    throw new CollaborationConfigurationError();
  }

  return new Redis({
    url: env.COLLAB_REDIS_REST_URL,
    token: env.COLLAB_REDIS_REST_TOKEN,
  });
}

export function createCollaborationRealtime(env: Env) {
  return new Realtime({
    schema: collaborationRealtimeSchema,
    redis: getCollaborationRedis(env),
    maxDurationSecs: REALTIME_CONNECTION_DURATION_SECONDS,
    // Do not apply a MAXLEN trim until snapshot compaction is implemented;
    // trimming accepted Yjs updates early would make room recovery incorrect.
    history: true,
  });
}
