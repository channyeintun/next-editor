import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { openSqliteD1 } from "../../db/testing";
import { passkeyRoute } from "./passkey";
import { authRoute } from "./session";

// The ceremonies' signature checks are stubbed; everything else (the signed
// challenge cookie, the session lookup, the SQL) runs for real against the
// production schema, so what is under test is who may add, remove and use a
// passkey.
vi.mock("@simplewebauthn/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: vi.fn<typeof verifyRegistrationResponse>(),
  verifyAuthenticationResponse: vi.fn<typeof verifyAuthenticationResponse>(),
}));

const T = Date.UTC(2026, 10, 11, 12, 0, 0);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const ORIGIN = "https://nexteditor.dev";

let sqlite: DatabaseSync;
let env: never;

function insertUser(id: string): void {
  sqlite
    .prepare(
      "INSERT INTO users (id, google_sub, email, username, created_at) VALUES (?, ?, ?, ?, 0)",
    )
    .run(id, `google-${id}`, `${id}@example.com`, id);
}

/** A live session for `userId` that signed in `signedInAgoMs` before now. */
function insertSession(id: string, userId: string, signedInAgoMs: number): void {
  const createdAt = Date.now() - signedInAgoMs;
  sqlite
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(id, userId, createdAt, createdAt + 30 * DAY);
}

function insertPasskey(id: string, userId: string): void {
  sqlite
    .prepare(
      "INSERT INTO passkey_credentials (id, user_id, public_key, counter, created_at) VALUES (?, ?, 'AQID', 0, 0)",
    )
    .run(id, userId);
}

function passkeyIds(): string[] {
  return sqlite
    .prepare("SELECT id FROM passkey_credentials ORDER BY id")
    .all()
    .map((row) => String(row.id));
}

function sessionIds(): string[] {
  return sqlite
    .prepare("SELECT id FROM sessions ORDER BY id")
    .all()
    .map((row) => String(row.id));
}

function challengeCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("ne_webauthn="))
    ?.split(";")[0];
  if (!cookie) throw new Error("expected a challenge cookie");
  return cookie;
}

function registerOptions(sessionId: string) {
  return passkeyRoute.request(
    `${ORIGIN}/register/options`,
    { method: "POST", headers: { cookie: `ne_session=${sessionId}` } },
    env,
  );
}

function registerVerify(sessionId: string, challenge: string, credentialId = "cred-x") {
  return passkeyRoute.request(
    `${ORIGIN}/register/verify`,
    {
      method: "POST",
      headers: {
        cookie: `ne_session=${sessionId}; ${challenge}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: credentialId, response: {} }),
    },
    env,
  );
}

async function signInWithPasskey(credentialId: string) {
  const options = await passkeyRoute.request(`${ORIGIN}/login/options`, { method: "POST" }, env);
  return passkeyRoute.request(
    `${ORIGIN}/login/verify`,
    {
      method: "POST",
      headers: { cookie: challengeCookie(options), "content-type": "application/json" },
      body: JSON.stringify({ id: credentialId, response: {} }),
    },
    env,
  );
}

function removePasskey(sessionId: string, credentialId: string) {
  return passkeyRoute.request(
    `${ORIGIN}/credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE", headers: { cookie: `ne_session=${sessionId}` } },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
  const opened = openSqliteD1();
  sqlite = opened.sqlite;
  env = { DB: opened.db, SESSION_SECRET: "test-secret", PUBLIC_URL: ORIGIN } as never;
  vi.mocked(verifyRegistrationResponse).mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: "cred-x", publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
    },
  } as never);
  vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  } as never);
  insertUser("u1");
  insertUser("u2");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("adding a passkey", () => {
  it("is allowed straight after signing in", async () => {
    insertSession("s-fresh", "u1", 1 * MINUTE);

    const options = await registerOptions("s-fresh");
    expect(options.status).toBe(200);
    const verify = await registerVerify("s-fresh", challengeCookie(options));

    expect(verify.status).toBe(200);
    expect(passkeyIds()).toEqual(["cred-x"]);
  });

  // A passkey outlives every session, so a session that has merely stayed
  // alive (a borrowed browser, a copied cookie) must not be able to mint one.
  it("is refused to a session that signed in long ago", async () => {
    insertSession("s-old", "u1", 29 * DAY);

    const options = await registerOptions("s-old");

    expect(options.status).toBe(403);
    expect(await options.json()).toMatchObject({ reauthenticate: true });
    expect(options.headers.getSetCookie().join("\n")).not.toMatch(/ne_webauthn=/);
  });

  it("refuses the verify step from an old session even with a valid challenge", async () => {
    insertSession("s-fresh", "u1", 1 * MINUTE);
    insertSession("s-old", "u1", 29 * DAY);
    const options = await registerOptions("s-fresh");

    const verify = await registerVerify("s-old", challengeCookie(options));

    expect(verify.status).toBe(403);
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
    expect(passkeyIds()).toEqual([]);
  });

  // The ceremony between the two steps can take until the challenge expires,
  // so a sign-in that was recent at options time still counts at verify.
  it("lets a ceremony started inside the window finish after it", async () => {
    insertSession("s-edge", "u1", 9 * MINUTE);
    const options = await registerOptions("s-edge");
    vi.setSystemTime(T + 4 * MINUTE);

    const verify = await registerVerify("s-edge", challengeCookie(options));

    expect(verify.status).toBe(200);
    expect(passkeyIds()).toEqual(["cred-x"]);
  });
});

describe("removing a passkey", () => {
  it("lets the owner remove one, which then no longer signs in", async () => {
    insertSession("s-old", "u1", 29 * DAY);
    insertPasskey("cred-x", "u1");

    const removed = await removePasskey("s-old", "cred-x");

    expect(removed.status).toBe(200);
    expect(passkeyIds()).toEqual([]);
    const signIn = await signInWithPasskey("cred-x");
    expect(signIn.status).toBe(400);
    expect(signIn.headers.getSetCookie().join("\n")).not.toMatch(/ne_session=/);
  });

  it("answers 404 for another account's passkey and leaves it in place", async () => {
    insertSession("s-u2", "u2", 1 * MINUTE);
    insertPasskey("cred-x", "u1");

    const removed = await removePasskey("s-u2", "cred-x");

    expect(removed.status).toBe(404);
    expect(passkeyIds()).toEqual(["cred-x"]);
  });

  it("needs a session", async () => {
    insertPasskey("cred-x", "u1");

    const removed = await passkeyRoute.request(
      `${ORIGIN}/credentials/cred-x`,
      { method: "DELETE" },
      env,
    );

    expect(removed.status).toBe(401);
    expect(passkeyIds()).toEqual(["cred-x"]);
  });
});

describe("signing out everywhere", () => {
  it("ends every session of the account, and only that account's", async () => {
    insertSession("s-here", "u1", 1 * MINUTE);
    insertSession("s-elsewhere", "u1", 20 * DAY);
    insertSession("s-other-account", "u2", 1 * MINUTE);

    const response = await authRoute.request(
      `${ORIGIN}/logout-everywhere`,
      { method: "POST", headers: { cookie: "ne_session=s-here" } },
      env,
    );

    expect(response.status).toBe(200);
    expect(sessionIds()).toEqual(["s-other-account"]);
    expect(response.headers.getSetCookie().join("\n")).toMatch(/ne_session=;/);
  });

  it("needs a session", async () => {
    insertSession("s-here", "u1", 1 * MINUTE);

    const response = await authRoute.request(
      `${ORIGIN}/logout-everywhere`,
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(401);
    expect(sessionIds()).toEqual(["s-here"]);
  });
});
