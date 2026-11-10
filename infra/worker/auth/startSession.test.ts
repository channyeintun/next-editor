import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { openSqliteD1 } from "../../db/testing";
import type { Env } from "../env";
import { startSession } from "./session";

// A sign-in overwrites the browser's ne_session cookie. The row the old
// cookie named must end with it: otherwise it stays a valid session until it
// expires, in reach of anyone who copied that cookie, though the browser that
// held it has moved on.
let sqlite: DatabaseSync;
let env: Env;

const app = new Hono<{ Bindings: Env }>();
app.post("/sign-in/:userId", async (c) => {
  const session = await startSession(c, c.req.param("userId"));
  return c.json({ sessionId: session.id });
});

function insertUser(id: string): void {
  sqlite
    .prepare(
      "INSERT INTO users (id, google_sub, email, username, created_at) VALUES (?, ?, ?, ?, 0)",
    )
    .run(id, `google-${id}`, `${id}@example.com`, id);
}

function insertLiveSession(id: string, userId: string): void {
  sqlite
    .prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)")
    .run(id, userId, Number.MAX_SAFE_INTEGER);
}

function sessionIds(): string[] {
  return sqlite
    .prepare("SELECT id FROM sessions ORDER BY id")
    .all()
    .map((row) => String(row.id));
}

async function signIn(userId: string, cookie?: string): Promise<string> {
  const response = await app.request(
    `https://nexteditor.dev/sign-in/${userId}`,
    { method: "POST", headers: cookie ? { cookie } : {} },
    env,
  );
  return ((await response.json()) as { sessionId: string }).sessionId;
}

beforeEach(() => {
  const opened = openSqliteD1();
  sqlite = opened.sqlite;
  env = { DB: opened.db } as Env;
  insertUser("u1");
  insertUser("u2");
});

describe("startSession", () => {
  it("ends the session the browser's cookie named when signing in again", async () => {
    insertLiveSession("s-old", "u1");
    insertLiveSession("s-other-device", "u1");

    const fresh = await signIn("u1", "ne_session=s-old");

    expect(sessionIds()).toEqual([fresh, "s-other-device"].sort());
  });

  // Switching accounts in one browser: the previous account's session ends
  // too, since its cookie is gone from this browser.
  it("ends it when the browser signs in to another account", async () => {
    insertLiveSession("s-old", "u1");

    const fresh = await signIn("u2", "ne_session=s-old");

    expect(sessionIds()).toEqual([fresh]);
  });

  it("signs in a browser that holds no session", async () => {
    insertLiveSession("s-other-device", "u1");

    const fresh = await signIn("u1");

    expect(sessionIds()).toEqual([fresh, "s-other-device"].sort());
  });
});
