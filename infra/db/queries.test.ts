// @vitest-environment node
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createSession,
  listPublishedLessons,
  upsertUserByGoogleSub,
  USERNAME_PATTERN,
} from "./queries";
import { openSqliteD1 } from "./testing";

/**
 * The gallery's paging, exercised against real SQLite rather than a stub, so
 * the SQL in queries.ts is what is under test — the defect this covers lives
 * in the ORDER BY, which a hand-rolled fake cannot reproduce.
 *
 * The bug: `ORDER BY published_at DESC` is not a total order. A backfill or a
 * bulk publish gives several rows the same millisecond, and SQLite may then
 * return tied rows in storage order. Page N and page N+1 are separate requests
 * (separately cached, see routes/lessons.ts), so if they disagree about the
 * order of a tie sitting on the boundary, the gallery renders one lesson twice
 * and never renders another at all.
 */

function insertUser(sqlite: DatabaseSync, id: string, username: string): void {
  sqlite
    .prepare(
      "INSERT INTO users (id, google_sub, email, username, created_at) VALUES (?, ?, ?, ?, 0)",
    )
    .run(id, `google-${id}`, `${id}@example.com`, username);
}

/** A database at the production schema holding these lessons, stored in this order. */
function createDb(rows: Array<{ id: string; publishedAt: number; status?: string }>): D1Database {
  const { db, sqlite } = openSqliteD1();
  insertUser(sqlite, "owner", "owner");
  const insert = sqlite.prepare(
    `INSERT INTO lessons (id, slug, owner_id, title, ne, status, published_at, created_at, updated_at)
     VALUES (?, ?, 'owner', ?, ?, ?, ?, 0, 0)`,
  );
  for (const row of rows) {
    insert.run(
      row.id,
      `slug-${row.id}`,
      row.id,
      `media/lessons/${row.id}/${row.id}.ne`,
      row.status ?? "published",
      row.publishedAt,
    );
  }
  return db;
}

// Six published lessons. Two share a millisecond, and with a page size of 3
// that tie falls exactly across the page-0/page-1 boundary — the position that
// turns an unstable sort into a visible duplicate.
const TIED_AT = 1_751_500_000_800;
const ROWS = [
  { id: "a", publishedAt: 1_751_500_001_000 },
  { id: "b", publishedAt: 1_751_500_000_900 },
  { id: "tie1", publishedAt: TIED_AT },
  { id: "tie2", publishedAt: TIED_AT },
  { id: "y", publishedAt: 1_751_500_000_700 },
  { id: "z", publishedAt: 1_751_500_000_600 },
];
const ALL_SLUGS = ROWS.map((row) => `slug-${row.id}`);

describe("listPublishedLessons", () => {
  it("returns every published lesson exactly once across pages", async () => {
    const db = createDb(ROWS);

    const first = await listPublishedLessons(db, 0, 3);
    const second = await listPublishedLessons(db, 1, 3);
    const slugs = [...first.rows, ...second.rows].map((row) => row.slug);

    expect(first.nextPage).toBe(1);
    expect(second.nextPage).toBeNull();
    expect(slugs).toHaveLength(ALL_SLUGS.length);
    expect(new Set(slugs).size).toBe(ALL_SLUGS.length);
    expect([...slugs].sort()).toEqual([...ALL_SLUGS].sort());
  });

  it("orders tied rows by data, not by the order they were stored", async () => {
    // Two databases holding the same lessons, inserted in a different order.
    // Anything the sort leaves to storage layout shows up as a difference here.
    const natural = createDb(ROWS);
    const shuffled = createDb([...ROWS].reverse());

    const fromNatural = (await listPublishedLessons(natural, 0, 10)).rows.map((row) => row.slug);
    const fromShuffled = (await listPublishedLessons(shuffled, 0, 10)).rows.map((row) => row.slug);

    expect(fromNatural).toEqual(fromShuffled);
  });

  it("never repeats or drops a lesson when two pages disagree about a tie", async () => {
    // Page 0 and page 1 are separate requests and may be served from different
    // cache entries or replicas. Model that worst case directly: fetch each
    // page from a database whose tied rows are stored the other way round.
    const forPageZero = createDb(ROWS);
    const forPageOne = createDb([ROWS[0], ROWS[1], ROWS[3], ROWS[2], ROWS[4], ROWS[5]]);

    const page0 = await listPublishedLessons(forPageZero, 0, 3);
    const page1 = await listPublishedLessons(forPageOne, 1, 3);
    const slugs = [...page0.rows, ...page1.rows].map((row) => row.slug);

    const duplicated = slugs.filter((slug, index) => slugs.indexOf(slug) !== index);
    const dropped = ALL_SLUGS.filter((slug) => !slugs.includes(slug));

    expect(duplicated, "a lesson rendered twice in the gallery").toEqual([]);
    expect(dropped, "a lesson the gallery can never reach").toEqual([]);
  });

  // `?page=1e300` passes the route's integer guard but multiplies into an offset
  // outside the int64 range, which SQLite binds as a REAL and rejects with
  // "datatype mismatch" — a 500 where every other out-of-range page is empty.
  it("answers an offset past the int64 range with an empty page instead of failing", async () => {
    let prepared = 0;
    const db = {
      prepare() {
        prepared += 1;
        throw new Error("the statement must not be issued for an unbindable offset");
      },
    } as unknown as D1Database;

    const page = await listPublishedLessons(db, 1e300, 12);

    expect(page.rows).toEqual([]);
    expect(page.nextPage).toBeNull();
    expect(prepared, "an unbindable offset reached D1").toBe(0);
  });

  it("ignores drafts and reports the last page", async () => {
    const db = createDb([
      { id: "p1", publishedAt: 3 },
      { id: "p2", publishedAt: 2 },
      { id: "d1", publishedAt: 1, status: "draft" },
    ]);

    const page = await listPublishedLessons(db, 0, 12);

    expect(page.rows.map((row) => row.slug)).toEqual(["slug-p1", "slug-p2"]);
    expect(page.nextPage).toBeNull();
  });
});

/**
 * The first-sign-in path at the production schema: `taken` are the usernames
 * already in the users table, and every candidate the loop probes is recorded.
 */
function makeUserDb(taken: string[]) {
  const probed: string[] = [];
  const { db, sqlite } = openSqliteD1({
    onStatement: (sql, args) => {
      if (sql.includes("SELECT 1 FROM users WHERE username")) probed.push(args[0] as string);
    },
  });
  for (const [index, username] of taken.entries()) {
    insertUser(sqlite, `taken-${index}`, username);
  }
  return { db, probed };
}

describe("upsertUserByGoogleSub", () => {
  it("prefers the bare slug and only suffixes on a real collision", async () => {
    const { db } = makeUserDb(["ada-lovelace"]);

    const row = await upsertUserByGoogleSub(db, {
      googleSub: "sub-ada",
      email: "ada@example.com",
      name: "Ada Lovelace",
      avatarUrl: null,
    });

    expect(row.username).toBe("ada-lovelace-1");
  });

  // PATCH /api/auth/username only accepts USERNAME_PATTERN (3-32 characters), so
  // a generated name outside it is one its owner could never choose again.
  it.each([
    ["Jo", "jo-1"],
    ["A", "a-1"],
    ["Maximilian Alexander von Habsburg-Lothringen", "maximilian-alexander-vo"],
  ])("generates a username the rename rule accepts for %j", async (name, expected) => {
    const { db } = makeUserDb([]);

    const row = await upsertUserByGoogleSub(db, {
      googleSub: `sub-${name}`,
      email: "someone@example.com",
      name,
      avatarUrl: null,
    });

    expect(row.username).toBe(expected);
    expect(row.username).toMatch(USERNAME_PATTERN);
  });

  // slugifyUsername strips everything outside [a-z0-9], so every display name
  // written entirely in a non-Latin script falls back to the same "user" base
  // and that whole cohort competes for one series. Unbounded, the Nth such
  // sign-in walked all N candidates, one sequential D1 round-trip at a time,
  // inside a single OAuth-callback invocation.
  it("stops probing usernames and takes a random suffix on a long collision run", async () => {
    const taken = ["user", ...Array.from({ length: 60 }, (_, index) => `user-${index + 1}`)];
    const { db, probed } = makeUserDb(taken);

    const row = await upsertUserByGoogleSub(db, {
      googleSub: "sub-1",
      email: "someone@example.com",
      name: "မောင်မောင်",
      avatarUrl: null,
    });

    expect(row.username).toMatch(/^user-[0-9a-f]{8}$/);
    expect(row.username).toMatch(USERNAME_PATTERN);
    expect(probed.length, "unbounded username probing").toBeLessThanOrEqual(51);
  });

  // A returning user is the common sign-in, so the refresh is the only
  // statement: one D1 round trip rather than a read and then a write.
  it("refreshes a returning user's profile in one statement and keeps their username", async () => {
    const statements: string[] = [];
    const { db, sqlite } = openSqliteD1({ onStatement: (sql) => statements.push(sql) });
    insertUser(sqlite, "user-1", "ada");

    const row = await upsertUserByGoogleSub(db, {
      googleSub: "google-user-1",
      email: "ada@new.example.com",
      name: "Ada L.",
      avatarUrl: "https://example.com/ada.png",
    });

    expect(row).toMatchObject({
      id: "user-1",
      username: "ada",
      email: "ada@new.example.com",
      name: "Ada L.",
      avatar_url: "https://example.com/ada.png",
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^\s*UPDATE users\b/);
  });

  // The same brand-new user's OAuth callback finishing in two tabs: both find
  // no row to refresh and race to INSERT, and the loser answers with the row
  // the winner wrote.
  it("answers with the row a concurrent first sign-in inserted first", async () => {
    let raced = false;
    const { db, sqlite } = openSqliteD1({
      onStatement: (sql) => {
        if (raced || !sql.includes("INSERT INTO users")) return;
        raced = true;
        insertUser(sqlite, "winner", "ada");
      },
    });

    const row = await upsertUserByGoogleSub(db, {
      googleSub: "google-winner",
      email: "ada@example.com",
      name: "Ada",
      avatarUrl: null,
    });

    expect(row).toMatchObject({ id: "winner", username: "ada" });
    expect(sqlite.prepare("SELECT id FROM users").all()).toEqual([{ id: "winner" }]);
  });
});

describe("createSession", () => {
  it("sweeps the user's own expired sessions and stores the new one, in one batch", async () => {
    const { db, sqlite } = openSqliteD1();
    insertUser(sqlite, "user-1", "ada");
    insertUser(sqlite, "user-2", "grace");
    const insertSession = sqlite.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, 0, ?)",
    );
    insertSession.run("expired", "user-1", 1);
    insertSession.run("live", "user-1", Number.MAX_SAFE_INTEGER);
    insertSession.run("someone-elses-expired", "user-2", 1);
    const batch = vi.spyOn(db, "batch");

    const session = await createSession(db, "user-1");

    const ids = sqlite
      .prepare("SELECT id FROM sessions")
      .all()
      .map((row) => row.id);
    expect(ids.sort()).toEqual([session.id, "live", "someone-elses-expired"].sort());
    expect(sqlite.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id)).toEqual({
      ...session,
    });
    expect(session.expires_at - session.created_at).toBe(30 * 24 * 60 * 60 * 1000);
    expect(batch).toHaveBeenCalledTimes(1);
  });
});
