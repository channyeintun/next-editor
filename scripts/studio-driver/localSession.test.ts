// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  LOCAL_DATABASE,
  LOCAL_SESSION_TTL_MS,
  LOCAL_STUDIO_USER,
  localSessionCommands,
  localSessionCookie,
  localSessionSql,
} from "./localSession.ts";

// The db layer compiles against the Workers types, which this project does
// not load, so its modules are imported by a path the typecheck does not
// follow. They are what proves the session is one the Worker accepts.
const DB_TESTING = "../../infra/db/testing.ts";
const DB_QUERIES = "../../infra/db/queries.ts";

interface LiveSession {
  user: { id: string; google_sub: string; email: string; username: string };
}
interface Db {
  openSqliteD1(): {
    db: unknown;
    sqlite: { exec(sql: string): void; prepare(sql: string): { get(): unknown } };
  };
}
interface Queries {
  getLiveSession(db: unknown, id: string): Promise<LiveSession | null>;
  USERNAME_PATTERN: RegExp;
}

describe("localSessionSql", () => {
  it("writes a user and a session that the Worker's session lookup accepts", async () => {
    const { openSqliteD1 } = (await import(/* @vite-ignore */ DB_TESTING)) as Db;
    const { getLiveSession, USERNAME_PATTERN } = (await import(
      /* @vite-ignore */ DB_QUERIES
    )) as Queries;
    const { db, sqlite } = openSqliteD1();
    const now = Date.now();
    sqlite.exec(localSessionSql({ sessionId: "s-1", nowMs: now }));
    const live = await getLiveSession(db, "s-1");
    expect(live?.user).toMatchObject({
      id: LOCAL_STUDIO_USER.id,
      google_sub: LOCAL_STUDIO_USER.googleSub,
      email: LOCAL_STUDIO_USER.email,
      username: LOCAL_STUDIO_USER.username,
    });
    expect(USERNAME_PATTERN.test(LOCAL_STUDIO_USER.username)).toBe(true);
  });

  it("signs in the same user again, sweeping its expired sessions", async () => {
    const { openSqliteD1 } = (await import(/* @vite-ignore */ DB_TESTING)) as Db;
    const { getLiveSession } = (await import(/* @vite-ignore */ DB_QUERIES)) as Queries;
    const { db, sqlite } = openSqliteD1();
    const old = Date.now() - 2 * LOCAL_SESSION_TTL_MS;
    sqlite.exec(localSessionSql({ sessionId: "old", nowMs: old }));
    sqlite.exec(localSessionSql({ sessionId: "new", nowMs: Date.now() }));
    expect(await getLiveSession(db, "old")).toBeNull();
    expect((await getLiveSession(db, "new"))?.user.id).toBe(LOCAL_STUDIO_USER.id);
    const counts = sqlite
      .prepare(
        "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM sessions) AS sessions",
      )
      .get();
    expect(counts).toEqual({ users: 1, sessions: 1 });
  });

  it("quotes every value it writes", () => {
    expect(localSessionSql({ sessionId: "it's", nowMs: 0 })).toContain("'it''s'");
  });
});

describe("localSessionCookie and commands", () => {
  it("is the plain ne_session cookie for the site, lasting as long as the row", () => {
    expect(
      localSessionCookie({ site: "http://localhost:5173", sessionId: "s", nowMs: 1_000 }),
    ).toEqual({
      name: "ne_session",
      value: "s",
      url: "http://localhost:5173",
      httpOnly: true,
      sameSite: "Lax",
      expires: Math.floor((1_000 + LOCAL_SESSION_TTL_MS) / 1000),
    });
  });

  it("only ever runs wrangler against the local state, with the repo's config", () => {
    const commands = localSessionCommands("SELECT 1;");
    expect(commands.map((args) => args.slice(0, 4))).toEqual([
      ["bunx", "wrangler", "d1", "migrations"],
      ["bunx", "wrangler", "d1", "execute"],
    ]);
    for (const args of commands) {
      expect(args).toContain("--local");
      expect(args).not.toContain("--remote");
      expect(args).toContain(LOCAL_DATABASE);
      expect(args.slice(args.indexOf("--config"), args.indexOf("--config") + 2)).toEqual([
        "--config",
        "infra/wrangler.toml",
      ]);
    }
    expect(commands[1].at(-1)).toBe("SELECT 1;");
  });
});
