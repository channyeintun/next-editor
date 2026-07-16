import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";

const sdk = vi.hoisted(() => ({
  redisConfigs: [] as unknown[],
  realtimeConfigs: [] as unknown[],
}));

vi.mock("@upstash/redis/cloudflare", () => ({
  Redis: class Redis {
    constructor(config: unknown) {
      sdk.redisConfigs.push(config);
    }
  },
}));

vi.mock("@upstash/realtime", () => ({
  Realtime: class Realtime {
    constructor(config: unknown) {
      sdk.realtimeConfigs.push(config);
    }
  },
}));

import {
  CollaborationConfigurationError,
  createCollaborationRealtime,
  getCollaborationRedis,
} from "./realtime";

afterEach(() => {
  sdk.redisConfigs.length = 0;
  sdk.realtimeConfigs.length = 0;
});

describe("collaboration Redis and Realtime configuration", () => {
  it.each([
    {},
    { COLLAB_REDIS_REST_URL: "", COLLAB_REDIS_REST_TOKEN: "token" },
    { COLLAB_REDIS_REST_URL: "   ", COLLAB_REDIS_REST_TOKEN: "token" },
    { COLLAB_REDIS_REST_URL: "http://redis.example.com", COLLAB_REDIS_REST_TOKEN: "token" },
    { COLLAB_REDIS_REST_URL: "https://redis.example.com", COLLAB_REDIS_REST_TOKEN: "   " },
  ])("fails closed for incomplete or insecure Redis credentials", (configuration) => {
    expect(() => getCollaborationRedis(configuration as Env)).toThrow(
      CollaborationConfigurationError,
    );
    expect(sdk.redisConfigs).toHaveLength(0);
  });

  it("uses the Cloudflare Redis SDK with explicit collaboration-safe options", () => {
    getCollaborationRedis({
      COLLAB_REDIS_REST_URL: "https://redis.example.com",
      COLLAB_REDIS_REST_TOKEN: "redis-token",
    } as Env);

    expect(sdk.redisConfigs).toEqual([
      {
        url: "https://redis.example.com",
        token: "redis-token",
        readYourWrites: true,
        automaticDeserialization: true,
        enableTelemetry: false,
      },
    ]);
  });

  it("configures typed Realtime history and bounded SSE rotation over the same Redis client", () => {
    createCollaborationRealtime({
      COLLAB_REDIS_REST_URL: "https://redis.example.com",
      COLLAB_REDIS_REST_TOKEN: "redis-token",
    } as Env);

    expect(sdk.redisConfigs).toHaveLength(1);
    expect(sdk.realtimeConfigs).toHaveLength(1);
    expect(sdk.realtimeConfigs[0]).toMatchObject({
      maxDurationSecs: 300,
      history: true,
    });
    expect(sdk.realtimeConfigs[0]).toHaveProperty("schema.document.update");
    expect(sdk.realtimeConfigs[0]).toHaveProperty("schema.awareness.state");
    expect(sdk.realtimeConfigs[0]).toHaveProperty("schema.control.room");
  });
});
