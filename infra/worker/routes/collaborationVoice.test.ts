import { describe, expect, it } from "vite-plus/test";
import type { Env } from "../env";
import { collaborationRoute } from "./collaboration";

const ROOM_ID = "10000000-0000-4000-8000-000000000001";

// Driven through collaborationRoute, which mounts the voice gateway, so these
// also pin the mount.
describe("voice availability", () => {
  it("answers 401 to a signed-out caller", async () => {
    const response = await collaborationRoute.request(
      `https://nexteditor.dev/rooms/${ROOM_ID}/voice/availability`,
      { method: "GET" },
      { DB: {} } as Env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not signed in" });
  });
});

describe("voice SFU gateway", () => {
  it("fails a GET closed as an unsupported operation", async () => {
    const response = await collaborationRoute.request(
      `https://nexteditor.dev/rooms/${ROOM_ID}/voice/sfu/generate-ice-servers`,
      { method: "GET" },
      { DB: {} } as Env,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "unsupported operation" });
  });

  it("refuses a request that is not JSON", async () => {
    const response = await collaborationRoute.request(
      `https://nexteditor.dev/rooms/${ROOM_ID}/voice/sfu/sessions/new`,
      { method: "POST" },
      { DB: {} } as Env,
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "unsupported content type" });
  });
});
