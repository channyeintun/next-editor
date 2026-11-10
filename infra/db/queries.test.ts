// @vitest-environment node
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { MAX_LESSONS_PER_OWNER, MAX_LIVE_SESSIONS_PER_USER } from "./ownerLimits";
import {
  createSession,
  insertDraftLesson,
  listPublishedLessons,
  type UpsertUserParams,
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
 * already in the users table, and `probes` holds the candidates of each
 * username lookup that ran, one entry per query. `onStatement` sees every
 * statement just before it runs.
 */
function makeUserDb(taken: string[], onStatement?: (sql: string, sqlite: DatabaseSync) => void) {
  const probes: string[][] = [];
  const { db, sqlite } = openSqliteD1({
    onStatement: (sql, args) => {
      if (/FROM users WHERE username (=|IN)/.test(sql)) probes.push(args as string[]);
      onStatement?.(sql, sqlite);
    },
  });
  for (const [index, username] of taken.entries()) {
    insertUser(sqlite, `taken-${index}`, username);
  }
  return { db, probes };
}

/** The account a sign-in that must succeed lands on. */
async function signedInUser(db: D1Database, params: UpsertUserParams) {
  const result = await upsertUserByGoogleSub(db, params);
  if (result.status !== "ok") throw new Error(`sign-in refused: ${result.status}`);
  return result.user;
}

describe("upsertUserByGoogleSub", () => {
  it("prefers the bare slug and only suffixes on a real collision", async () => {
    const { db } = makeUserDb(["ada-lovelace"]);

    const row = await signedInUser(db, {
      googleSub: "sub-ada",
      email: "ada@example.com",
      emailVerified: true,
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

    const row = await signedInUser(db, {
      googleSub: `sub-${name}`,
      email: "someone@example.com",
      emailVerified: true,
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
    const { db, probes } = makeUserDb(taken);

    const row = await signedInUser(db, {
      googleSub: "sub-1",
      email: "someone@example.com",
      emailVerified: true,
      name: "မောင်မောင်",
      avatarUrl: null,
    });

    expect(row.username).toMatch(/^user-[0-9a-f]{8}$/);
    expect(row.username).toMatch(USERNAME_PATTERN);
    expect(probes.flat().length, "unbounded username probing").toBeLessThanOrEqual(51);
  });

  it("gives that cohort the bare base while it is free", async () => {
    const { db } = makeUserDb(["user-1", "user-2", "user-3"]);

    const row = await signedInUser(db, {
      googleSub: "sub-new",
      email: "someone@example.com",
      emailVerified: true,
      name: "မောင်မောင်",
      avatarUrl: null,
    });

    expect(row.username).toBe("user");
  });

  // Each candidate used to be its own awaited SELECT, so the Nth member of that
  // cohort waited on N sequential D1 round trips before their session began.
  it("finds the first free suffix with one lookup", async () => {
    const { db, probes } = makeUserDb(["user", "user-1"]);

    const row = await signedInUser(db, {
      googleSub: "sub-new",
      email: "someone@example.com",
      emailVerified: true,
      name: "မောင်မောင်",
      avatarUrl: null,
    });

    expect(row.username).toBe("user-2");
    expect(probes).toHaveLength(1);
  });

  // Another brand-new sign-in takes the same username between this one's
  // lookup and its INSERT: the INSERT hits UNIQUE(username), and the retry
  // looks again and takes the next free suffix.
  it("looks again and takes the next suffix when a concurrent sign-in wins the name", async () => {
    let raced = false;
    const { db, probes } = makeUserDb(["user", "user-1"], (sql, sqlite) => {
      if (raced || !sql.includes("INSERT INTO users")) return;
      raced = true;
      insertUser(sqlite, "rival", "user-2");
    });

    const row = await signedInUser(db, {
      googleSub: "sub-new",
      email: "someone@example.com",
      emailVerified: true,
      name: "မောင်မောင်",
      avatarUrl: null,
    });

    expect(row.username).toBe("user-3");
    expect(probes).toHaveLength(2);
  });

  // A returning user is the common sign-in, so the refresh is the only
  // statement: one D1 round trip rather than a read and then a write.
  it("refreshes a returning user's profile in one statement and keeps their username", async () => {
    const statements: string[] = [];
    const { db, sqlite } = openSqliteD1({ onStatement: (sql) => statements.push(sql) });
    insertUser(sqlite, "user-1", "ada");

    const row = await signedInUser(db, {
      googleSub: "google-user-1",
      email: "ada@new.example.com",
      emailVerified: true,
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

    const row = await signedInUser(db, {
      googleSub: "google-winner",
      email: "ada@example.com",
      emailVerified: true,
      name: "Ada",
      avatarUrl: null,
    });

    expect(row).toMatchObject({ id: "winner", username: "ada" });
    expect(sqlite.prepare("SELECT id FROM users").all()).toEqual([{ id: "winner" }]);
  });
});

// users.email is UNIQUE (0001_init.sql) but filled from Google's `email`
// claim, which Google does not promise is unique per account (sub): an address
// can move to a new Google account. Accounts are keyed on google_sub, so a
// collision must neither 500 the sign-in nor touch the other account's row.
describe("upsertUserByGoogleSub email collisions", () => {
  function googleUsers(sqlite: DatabaseSync) {
    return sqlite.prepare("SELECT google_sub, email, name FROM users ORDER BY google_sub").all();
  }

  it("refuses a new Google identity whose address another account holds", async () => {
    const { db, sqlite } = openSqliteD1();
    await upsertUserByGoogleSub(db, {
      googleSub: "sub-a",
      email: "shared@example.test",
      emailVerified: true,
      name: "A",
      avatarUrl: null,
    });

    const result = await upsertUserByGoogleSub(db, {
      googleSub: "sub-b",
      email: "shared@example.test",
      emailVerified: true,
      name: "B",
      avatarUrl: null,
    });

    expect(result).toEqual({ status: "email-in-use" });
    expect(googleUsers(sqlite)).toEqual([
      { google_sub: "sub-a", email: "shared@example.test", name: "A" },
    ]);
  });

  it("signs a returning user in when their new address belongs to another account", async () => {
    const { db, sqlite } = openSqliteD1();
    for (const [googleSub, email] of [
      ["sub-a", "a@example.test"],
      ["sub-b", "b@example.test"],
    ]) {
      await upsertUserByGoogleSub(db, {
        googleSub,
        email,
        emailVerified: true,
        name: googleSub,
        avatarUrl: null,
      });
    }

    const result = await upsertUserByGoogleSub(db, {
      googleSub: "sub-a",
      email: "b@example.test",
      emailVerified: true,
      name: "A renamed",
      avatarUrl: null,
    });

    expect(result).toMatchObject({
      status: "ok",
      user: { google_sub: "sub-a", email: "a@example.test", name: "A renamed" },
    });
    expect(googleUsers(sqlite)).toEqual([
      { google_sub: "sub-a", email: "a@example.test", name: "A renamed" },
      { google_sub: "sub-b", email: "b@example.test", name: "sub-b" },
    ]);
  });

  // An unverified address could be someone else's: storing it would claim it
  // in the UNIQUE column and lock its real owner out of signing up.
  it("never creates an account on an address Google has not verified", async () => {
    const { db, sqlite } = openSqliteD1();

    const result = await upsertUserByGoogleSub(db, {
      googleSub: "sub-a",
      email: "someone-else@example.test",
      emailVerified: false,
      name: "A",
      avatarUrl: null,
    });

    expect(result).toEqual({ status: "email-unverified" });
    expect(googleUsers(sqlite)).toEqual([]);
  });

  it("keeps a returning user's stored address when Google has not verified the new one", async () => {
    const { db } = openSqliteD1();
    await upsertUserByGoogleSub(db, {
      googleSub: "sub-a",
      email: "a@example.test",
      emailVerified: true,
      name: "A",
      avatarUrl: null,
    });

    const result = await upsertUserByGoogleSub(db, {
      googleSub: "sub-a",
      email: "unverified@example.test",
      emailVerified: false,
      name: "A",
      avatarUrl: "https://example.test/a.png",
    });

    expect(result).toMatchObject({
      status: "ok",
      user: { email: "a@example.test", avatar_url: "https://example.test/a.png" },
    });
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

  it("keeps at most MAX_LIVE_SESSIONS_PER_USER live sessions, ending the oldest", async () => {
    const { db, sqlite } = openSqliteD1();
    insertUser(sqlite, "user-1", "ada");
    insertUser(sqlite, "user-2", "grace");
    const insertSession = sqlite.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    );
    // More live sessions than the cap, as repeated sign-ins used to pile up.
    for (let index = 0; index < MAX_LIVE_SESSIONS_PER_USER + 5; index++) {
      insertSession.run(`old-${index}`, "user-1", index, Number.MAX_SAFE_INTEGER);
    }
    insertSession.run("someone-elses", "user-2", 0, Number.MAX_SAFE_INTEGER);

    const session = await createSession(db, "user-1");

    const ids = sqlite
      .prepare("SELECT id FROM sessions WHERE user_id = 'user-1' ORDER BY created_at")
      .all()
      .map((row) => row.id);
    expect(ids).toHaveLength(MAX_LIVE_SESSIONS_PER_USER);
    expect(ids.at(-1)).toBe(session.id);
    // The newest of the earlier sessions stay signed in; the oldest are ended.
    expect(ids[0]).toBe(`old-${6}`);
    expect(sqlite.prepare("SELECT id FROM sessions WHERE user_id = 'user-2'").all()).toHaveLength(
      1,
    );
  });
});

describe("insertDraftLesson", () => {
  function draft(id: string, ownerId = "owner") {
    return {
      id,
      slug: `slug-${id}`,
      ownerId,
      title: "Flood",
      description: null,
      thumbnail: null,
      ne: `media/lessons/${id}/${id}.ne`,
      duration: null,
      tags: null,
      author: null,
      authorUrl: null,
    };
  }

  it("refuses a lesson past MAX_LESSONS_PER_OWNER, inside the INSERT", async () => {
    const { db, sqlite } = openSqliteD1();
    insertUser(sqlite, "owner", "owner");
    insertUser(sqlite, "other", "other");
    const insert = sqlite.prepare(
      `INSERT INTO lessons (id, slug, owner_id, title, ne, created_at, updated_at)
       VALUES (?, ?, 'owner', 'Flood', ?, 0, 0)`,
    );
    for (let index = 0; index < MAX_LESSONS_PER_OWNER - 1; index++) {
      insert.run(`seed-${index}`, `seed-${index}`, `media/lessons/seed-${index}/x.ne`);
    }

    expect(await insertDraftLesson(db, draft("last"))).toMatchObject({ id: "last" });
    expect(await insertDraftLesson(db, draft("one-too-many"))).toBeNull();
    const count = sqlite
      .prepare("SELECT COUNT(*) AS n FROM lessons WHERE owner_id = 'owner'")
      .get();
    expect(count).toEqual({ n: MAX_LESSONS_PER_OWNER });
    // The cap is per owner.
    expect(await insertDraftLesson(db, draft("elsewhere", "other"))).toMatchObject({
      owner_id: "other",
    });
  });
});
