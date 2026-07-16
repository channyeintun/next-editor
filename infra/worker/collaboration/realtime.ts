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

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

// Collaboration is fail-closed. Unlike the optional gallery cache, an
// accepted document update cannot silently fall back to a different store.
export function getCollaborationRedis(env: Env): Redis {
  const url = env.COLLAB_REDIS_REST_URL;
  const token = env.COLLAB_REDIS_REST_TOKEN;
  if (
    typeof url !== "string" ||
    url.trim().length === 0 ||
    !isHttpsUrl(url) ||
    typeof token !== "string" ||
    token.trim().length === 0
  ) {
    throw new CollaborationConfigurationError();
  }

  return new Redis({
    url,
    token,
    // Document acceptance performs dependent REST commands. Preserve the
    // SDK's consistency token so later commands observe earlier writes.
    readYourWrites: true,
    // Realtime stream entries contain structured event envelopes.
    automaticDeserialization: true,
    // Collaboration does not need anonymous SDK environment telemetry.
    enableTelemetry: false,
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
