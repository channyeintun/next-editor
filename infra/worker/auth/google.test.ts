import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { googleAuthRoute } from "./google";
import { verifyGoogleIdToken } from "./googleIdToken";

vi.mock("./googleIdToken", () => ({
  verifyGoogleIdToken: vi.fn<typeof verifyGoogleIdToken>(),
}));

vi.mock("../../db/queries", () => ({
  upsertUserByGoogleSub: vi.fn<() => Promise<unknown>>(),
  createSession: vi.fn<() => Promise<unknown>>(),
}));

const env = {
  DB: {} as D1Database,
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  PUBLIC_URL: "https://nexteditor.dev",
  SESSION_SECRET: "session-secret",
} as never;

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

describe("googleAuthRoute redirect callback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A /callback request carrying the handshake cookie /login just set. */
  async function callbackAfterLogin() {
    const login = await googleAuthRoute.request("https://nexteditor.dev/login", {}, env);
    const state = new URL(login.headers.get("location")!).searchParams.get("state");
    const handshake = login.headers.getSetCookie()[0]!.split(";")[0]!;
    return googleAuthRoute.request(
      `https://nexteditor.dev/callback?code=auth-code&state=${state}`,
      { headers: { cookie: handshake } },
      env,
    );
  }

  // The token exchange had no timeout and no catch, so a stalled Google kept
  // the sign-in waiting, and a network error escaped as a bare 500.
  it("answers 502 without a session when Google's token endpoint is unreachable", async () => {
    const tokenFetch = vi.fn<typeof fetch>(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    vi.stubGlobal("fetch", tokenFetch);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await callbackAfterLogin();

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("OAuth error: Google token exchange failed (unreachable).");
    expect(tokenFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(response.headers.getSetCookie().join("\n")).not.toMatch(/ne_session=/);
    expect(logged).toHaveBeenCalledOnce();
  });
});
