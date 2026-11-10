import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import { openSqliteD1 } from "../../db/testing";
import { googleAuthRoute } from "./google";
import { verifyGoogleIdToken } from "./googleIdToken";

// Only the token's signature check is stubbed: the upsert and the session run
// against the production schema, so what is under test is how a sign-in
// answers when users.email (UNIQUE) cannot take the token's address.
vi.mock("./googleIdToken", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./googleIdToken")>()),
  verifyGoogleIdToken: vi.fn<typeof verifyGoogleIdToken>(),
}));

let sqlite: DatabaseSync;
let env: never;

function insertGoogleUser(id: string, googleSub: string, email: string): void {
  sqlite
    .prepare(
      "INSERT INTO users (id, google_sub, email, name, username, created_at) VALUES (?, ?, ?, ?, ?, 0)",
    )
    .run(id, googleSub, email, id, id);
}

function oneTapAs(identity: Awaited<ReturnType<typeof verifyGoogleIdToken>>) {
  vi.mocked(verifyGoogleIdToken).mockResolvedValue(identity);
  return googleAuthRoute.request(
    "https://nexteditor.dev/onetap",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: "dummy" }),
    },
    env,
  );
}

function users() {
  return sqlite.prepare("SELECT id, google_sub, email FROM users ORDER BY id").all();
}

beforeEach(() => {
  vi.clearAllMocks();
  const opened = openSqliteD1();
  sqlite = opened.sqlite;
  env = {
    DB: opened.db,
    GOOGLE_CLIENT_ID: "test-client",
    SESSION_SECRET: "test-secret",
    PUBLIC_URL: "https://nexteditor.dev",
  } as never;
  insertGoogleUser("user-a", "sub-a", "shared@example.test");
});

describe("Google sign-in when the address is already taken", () => {
  it("answers a new Google identity with 409 and leaves the holder's account alone", async () => {
    const response = await oneTapAs({
      sub: "sub-b",
      email: "shared@example.test",
      emailVerified: true,
    });

    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie().join("\n")).not.toMatch(/ne_session=/);
    expect(users()).toEqual([{ id: "user-a", google_sub: "sub-a", email: "shared@example.test" }]);
  });

  it("still signs in a returning user whose new address another account holds", async () => {
    insertGoogleUser("user-b", "sub-b", "b@example.test");

    const response = await oneTapAs({
      sub: "sub-b",
      email: "shared@example.test",
      emailVerified: true,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { id: "user-b", email: "b@example.test" },
    });
    expect(response.headers.getSetCookie().join("\n")).toMatch(/ne_session=/);
  });

  it("refuses to create an account on an address Google has not verified", async () => {
    const response = await oneTapAs({
      sub: "sub-c",
      email: "victim@example.test",
      emailVerified: false,
    });

    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie().join("\n")).not.toMatch(/ne_session=/);
    expect(users()).toHaveLength(1);
  });
});
