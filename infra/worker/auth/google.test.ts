import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { googleAuthRoute } from "./google";
import { verifyGoogleIdToken } from "./googleIdToken";

vi.mock("./googleIdToken", () => ({
  verifyGoogleIdToken: vi.fn<typeof verifyGoogleIdToken>(),
}));

vi.mock("../../db/queries", () => ({
  upsertUserByGoogleSub: vi.fn<() => Promise<unknown>>(),
  createSession: vi.fn<() => Promise<unknown>>(),
}));

const env = { DB: {} as D1Database, GOOGLE_CLIENT_ID: "client-id" } as never;

function oneTap(body: string) {
  return googleAuthRoute.request(
    "https://nexteditor.dev/onetap",
    { method: "POST", body, headers: { "content-type": "application/json" } },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("googleAuthRoute One Tap", () => {
  it.each(["", "{credential", "null", "[]", '"token"', "{}", '{"credential":1}'])(
    "answers the body %j with 400",
    async (body) => {
      const response = await oneTap(body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Missing credential." });
      expect(verifyGoogleIdToken).not.toHaveBeenCalled();
    },
  );

  // Reachable without a session, so the body is read under a byte ceiling
  // before it is parsed.
  it("refuses a body over the request ceiling", async () => {
    const response = await oneTap(JSON.stringify({ credential: "x".repeat(8 * 1024) }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body is too large" });
    expect(verifyGoogleIdToken).not.toHaveBeenCalled();
  });
});
