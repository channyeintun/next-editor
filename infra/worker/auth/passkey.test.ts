import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { passkeyRoute } from "./passkey";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { SessionRow } from "../../db/types";

vi.mock("@simplewebauthn/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simplewebauthn/server")>()),
  verifyAuthenticationResponse: vi.fn<typeof verifyAuthenticationResponse>(),
}));

vi.mock("../../db/passkeyQueries", () => ({
  getPasskeyCredentialWithUser: vi.fn<() => Promise<unknown>>(async () => ({
    credential: { id: "cred-1", public_key: "AQID", counter: 0, transports: null },
    user: { id: "user-1", email: "ada@example.com", name: "Ada", username: "ada" },
  })),
  updatePasskeyCredentialAfterAuth: vi.fn<() => Promise<void>>(async () => {}),
  insertPasskeyCredential: vi.fn<() => Promise<void>>(),
  listPasskeyCredentials: vi.fn<() => Promise<unknown[]>>(async () => []),
}));

vi.mock("../../db/queries", () => ({
  createSession: vi.fn<() => Promise<SessionRow>>(async () => ({
    id: "session-1",
    user_id: "user-1",
    created_at: 1_000,
    expires_at: 1_000 + 30 * 24 * 60 * 60 * 1000,
  })),
}));

const env = {
  DB: {} as D1Database,
  SESSION_SECRET: "test-secret",
  PUBLIC_URL: "https://nexteditor.dev",
} as never;

/** Runs /login/options and returns the signed challenge cookie it set. */
async function issueLoginChallenge(): Promise<string> {
  const response = await passkeyRoute.request(
    "https://nexteditor.dev/login/options",
    { method: "POST" },
    env,
  );
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("expected a challenge cookie");
  return cookie;
}

function verifyLogin(cookie: string) {
  return passkeyRoute.request(
    "https://nexteditor.dev/login/verify",
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ id: "cred-1", response: {} }),
    },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 0 },
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("passkey sign-in challenge", () => {
  it("signs in with a challenge issued moments ago", async () => {
    const cookie = await issueLoginChallenge();

    const response = await verifyLogin(cookie);

    expect(response.status).toBe(200);
    // The session cookie lives exactly as long as the session row.
    expect(response.headers.get("set-cookie")).toContain("ne_session=session-1; Max-Age=2592000;");
  });

  it("refuses a challenge once it has expired, even though its signature is valid", async () => {
    const cookie = await issueLoginChallenge();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const response = await verifyLogin(cookie);

    expect(response.status).toBe(400);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  // /login/verify is reachable without a session, so its body is read under
  // a byte ceiling before it is parsed.
  it("refuses an assertion body over the request ceiling", async () => {
    const cookie = await issueLoginChallenge();

    const response = await passkeyRoute.request(
      "https://nexteditor.dev/login/verify",
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ id: "cred-1", response: {}, padding: "x".repeat(32 * 1024) }),
      },
      env,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body is too large" });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });
});
