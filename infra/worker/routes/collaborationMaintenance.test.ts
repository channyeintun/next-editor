import { describe, expect, it } from "vite-plus/test";
import type { Env } from "../env";
import { collaborationRoute } from "./collaboration";

// Driven through collaborationRoute, which mounts the maintenance receiver, so
// these also pin the mount.
describe("POST /jobs/maintenance", () => {
  const job = JSON.stringify({
    kind: "cleanup-room",
    roomId: "10000000-0000-4000-8000-000000000001",
    closedAt: 1_700_000_000_000,
  });

  it("answers 503 while the QStash signing keys are not configured", async () => {
    const response = await collaborationRoute.request(
      "https://nexteditor.dev/jobs/maintenance",
      { method: "POST", body: job },
      { DB: {} } as Env,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "maintenance receiver unavailable" });
  });

  it("refuses a job without a QStash signature", async () => {
    const response = await collaborationRoute.request(
      "https://nexteditor.dev/jobs/maintenance",
      { method: "POST", body: job },
      {
        DB: {},
        PUBLIC_URL: "https://nexteditor.dev",
        QSTASH_CURRENT_SIGNING_KEY: "current",
        QSTASH_NEXT_SIGNING_KEY: "next",
      } as Env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid maintenance signature" });
  });
});
