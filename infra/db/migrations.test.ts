// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { matchRoutes } from "react-router";
import { describe, expect, it } from "vitest";

/**
 * Data migrations run against the real schema: every earlier migration is
 * applied first, in the order wrangler applies them, so their UPDATEs meet the
 * same tables and UNIQUE constraints as production does.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));
const RENAME_MIGRATION = "0013_rename_unreachable_slugs.sql";
const USERNAME_MIGRATION = "0014_reachable_usernames.sql";

const OWNER_ID = "00000000-0000-4000-8000-000000000000";

interface SluggedRow {
  id: string;
  slug: string;
  updatedAt: number;
}

function readMigration(name: string): string {
  return readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8");
}

/** Every migration wrangler applies before `migration`, in its order. */
function migrationsBefore(migration: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && name < migration)
    .sort();
}

/** A database at the schema just before 0013, holding the given rows. */
function databaseBeforeRename(rows: { lessons: SluggedRow[]; playlists: SluggedRow[] }) {
  const db = new DatabaseSync(":memory:");
  for (const name of migrationsBefore(RENAME_MIGRATION)) {
    db.exec(readMigration(name));
  }

  db.prepare(
    "INSERT INTO users (id, google_sub, email, name, username, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(OWNER_ID, "google-sub", "owner@example.com", "Owner", "owner", 0);
  const insertLesson = db.prepare(
    "INSERT INTO lessons (id, slug, owner_id, title, ne, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const { id, slug, updatedAt } of rows.lessons) {
    insertLesson.run(id, slug, OWNER_ID, slug, `/media/lessons/${id}/${id}.ne`, 0, updatedAt);
  }
  const insertPlaylist = db.prepare(
    "INSERT INTO playlists (id, slug, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const { id, slug, updatedAt } of rows.playlists) {
    insertPlaylist.run(id, slug, OWNER_ID, slug, 0, updatedAt);
  }
  return db;
}

function applyRename(db: DatabaseSync): void {
  db.exec(readMigration(RENAME_MIGRATION));
}

function slugsOf(db: DatabaseSync, table: "lessons" | "playlists") {
  return db.prepare(`SELECT slug, updated_at FROM ${table} ORDER BY id`).all();
}

function snapshot(db: DatabaseSync) {
  return {
    lessons: db.prepare("SELECT * FROM lessons ORDER BY id").all(),
    playlists: db.prepare("SELECT * FROM playlists ORDER BY id").all(),
  };
}

describe("0013_rename_unreachable_slugs", () => {
  it("moves rows off unreachable slugs", () => {
    const db = databaseBeforeRename({
      lessons: [
        { id: "aaaaaaaa-0000-4000-8000-000000000001", slug: "mine", updatedAt: 1 },
        { id: "bbbbbbbb-0000-4000-8000-000000000002", slug: "introduction", updatedAt: 2 },
        { id: "dddddddd-0000-4000-8000-000000000003", slug: "mine-1", updatedAt: 3 },
        { id: "eeeeeeee-0000-4000-8000-000000000004", slug: "intro-to-go", updatedAt: 4 },
      ],
      playlists: [
        { id: "cccccccc-0000-4000-8000-000000000005", slug: "mine", updatedAt: 5 },
        // Playlists have no seed to lose to, so this one is reachable as is.
        { id: "ffffffff-0000-4000-8000-000000000006", slug: "introduction", updatedAt: 6 },
      ],
    });

    applyRename(db);

    expect(slugsOf(db, "lessons")).toEqual([
      { slug: "mine-aaaaaaaa", updated_at: 1 },
      { slug: "introduction-bbbbbbbb", updated_at: 2 },
      { slug: "mine-1", updated_at: 3 },
      { slug: "intro-to-go", updated_at: 4 },
    ]);
    expect(slugsOf(db, "playlists")).toEqual([
      { slug: "mine-cccccccc", updated_at: 5 },
      { slug: "introduction", updated_at: 6 },
    ]);
  });

  it("changes nothing when no row holds a reserved slug", () => {
    const db = databaseBeforeRename({
      lessons: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", slug: "mine-1", updatedAt: 1 }],
      playlists: [{ id: "cccccccc-0000-4000-8000-000000000002", slug: "minecraft", updatedAt: 2 }],
    });
    const before = snapshot(db);

    applyRename(db);

    expect(snapshot(db)).toEqual(before);
  });

  it("is idempotent", () => {
    const db = databaseBeforeRename({
      lessons: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", slug: "mine", updatedAt: 1 }],
      playlists: [{ id: "cccccccc-0000-4000-8000-000000000002", slug: "mine", updatedAt: 2 }],
    });
    applyRename(db);
    const once = snapshot(db);

    applyRename(db);

    expect(snapshot(db)).toEqual(once);
  });
});

/** A user who signed up before 0002, which built their username from `name`. */
interface BackfilledUser {
  id: string;
  name: string;
}

/** A user who signed up after 0002 and was issued `username` directly. */
interface IssuedUser {
  id: string;
  username: string;
}

/**
 * A database at the schema just before 0014. Backfilled users are inserted
 * before 0002 runs, so their usernames and author links come from 0002's own
 * backfill, exactly as in production. Every user owns one lesson.
 */
function databaseBeforeUsernameRewrite(users: {
  backfilled: BackfilledUser[];
  issued?: IssuedUser[];
}) {
  const db = new DatabaseSync(":memory:");
  const [init, ...later] = migrationsBefore(USERNAME_MIGRATION);
  db.exec(readMigration(init));

  const insertBackfilled = db.prepare(
    "INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const { id, name } of users.backfilled) {
    insertBackfilled.run(id, `sub-${id}`, `${id}@example.com`, name, 0);
    insertLessonOwnedBy(db, id, null);
  }

  for (const name of later) {
    db.exec(readMigration(name));
  }

  const insertIssued = db.prepare(
    "INSERT INTO users (id, google_sub, email, name, username, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const { id, username } of users.issued ?? []) {
    insertIssued.run(id, `sub-${id}`, `${id}@example.com`, username, username, 0);
    insertLessonOwnedBy(db, id, `/learn/@${username}`);
  }
  return db;
}

function insertLessonOwnedBy(db: DatabaseSync, ownerId: string, authorUrl: string | null): void {
  db.prepare(
    "INSERT INTO lessons (id, slug, owner_id, title, ne, author_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    ownerId,
    `lesson-${ownerId}`,
    ownerId,
    "Lesson",
    `/media/lessons/${ownerId}.ne`,
    authorUrl,
    0,
    0,
  );
}

function applyUsernameRewrite(db: DatabaseSync): void {
  db.exec(readMigration(USERNAME_MIGRATION));
}

function accounts(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT users.id, users.username, lessons.author_url FROM users
       JOIN lessons ON lessons.owner_id = users.id
       ORDER BY users.id`,
    )
    .all() as Array<{ id: string; username: string; author_url: string }>;
}

/**
 * Whether the profile link every surface builds, `/learn/@${username}` with no
 * encoding, reaches this user: the browser parses the URL, then the SPA's one
 * /learn/:slug route decodes the path and must hand back the same name.
 */
function profileLoads(username: string): boolean {
  const { pathname } = new URL(`/learn/@${username}`, "https://nexteditor.dev");
  const [match] = matchRoutes([{ path: "/learn/:slug" }], pathname) ?? [];
  return match?.params.slug === `@${username}`;
}

// Each keeps a character of the display name that 0002 copied verbatim and
// that splits, cuts short or decodes the profile URL.
const UNREACHABLE: BackfilledUser[] = [
  { id: "11111111-0000-4000-8000-000000000001", name: "Chan / Dev" },
  { id: "22222222-0000-4000-8000-000000000002", name: "C# Guy" },
  { id: "33333333-0000-4000-8000-000000000003", name: "Who? Me" },
  { id: "44444444-0000-4000-8000-000000000004", name: "back\\slash" },
  { id: "55555555-0000-4000-8000-000000000005", name: "50%50" },
  // %7f is the last ASCII escape, so it still decodes.
  { id: "cccccccc-0000-4000-8000-00000000000c", name: "a%7fb" },
];

// Outside today's rename rule, but each loads its own profile.
const REACHABLE: BackfilledUser[] = [
  { id: "66666666-0000-4000-8000-000000000006", name: "Jo" },
  {
    id: "77777777-0000-4000-8000-000000000007",
    name: "Maximilian Alexander von Habsburg-Lothringen",
  },
  // A '%' that starts no escape is left undecoded by the router.
  { id: "88888888-0000-4000-8000-000000000008", name: "100% Sure" },
  { id: "99999999-0000-4000-8000-000000000009", name: "100%Effort" },
  { id: "aaaaaaaa-0000-4000-8000-00000000000a", name: "မောင်မောင်" },
  // %80 starts no valid UTF-8 sequence, so the router leaves the path as written.
  { id: "dddddddd-0000-4000-8000-00000000000d", name: "a%80b" },
];

// Renames once accepted a name this short.
const ISSUED: IssuedUser[] = [{ id: "bbbbbbbb-0000-4000-8000-00000000000b", username: "jo" }];

describe("0014_reachable_usernames", () => {
  it("makes every username load at its /learn/@ URL", () => {
    const db = databaseBeforeUsernameRewrite({
      backfilled: [...UNREACHABLE, ...REACHABLE],
      issued: ISSUED,
    });
    const unreachable = () =>
      accounts(db)
        .map(({ username }) => username)
        .filter((username) => !profileLoads(username));
    expect(unreachable(), "the names 0002 left these users with").toEqual([
      "chan-/-dev-11111111",
      "c#-guy-22222222",
      "who?-me-33333333",
      "back\\slash-44444444",
      "50%50-55555555",
      "a%7fb-cccccccc",
    ]);

    applyUsernameRewrite(db);

    expect(unreachable()).toEqual([]);
    const rewritten = accounts(db).filter(({ id }) => UNREACHABLE.some((user) => user.id === id));
    expect(rewritten.map(({ username }) => username)).toEqual([
      "chan---dev-11111111",
      "c--guy-22222222",
      "who--me-33333333",
      "back-slash-44444444",
      "50-50-55555555",
      "a-7fb-cccccccc",
    ]);
    for (const { username, author_url } of rewritten) {
      expect(author_url).toBe(`/learn/@${username}`);
    }
  });

  it("leaves every username that already loads untouched", () => {
    const db = databaseBeforeUsernameRewrite({ backfilled: REACHABLE, issued: ISSUED });
    const before = accounts(db);
    expect(before.map(({ username }) => username)).toEqual([
      "jo-66666666",
      "maximilian-alexander-von-habsburg-lothringen-77777777",
      "100%-sure-88888888",
      "100%effort-99999999",
      "မောင်မောင်-aaaaaaaa",
      "jo",
      "a%80b-dddddddd",
    ]);

    applyUsernameRewrite(db);

    expect(accounts(db)).toEqual(before);
  });

  it("changes nothing when run again", () => {
    const db = databaseBeforeUsernameRewrite({
      backfilled: [...UNREACHABLE, ...REACHABLE],
      issued: ISSUED,
    });
    applyUsernameRewrite(db);
    const once = accounts(db);

    applyUsernameRewrite(db);

    expect(accounts(db)).toEqual(once);
  });

  it("fails instead of merging two accounts", () => {
    const db = databaseBeforeUsernameRewrite({
      backfilled: [{ id: "11111111-0000-4000-8000-000000000001", name: "a/b" }],
      issued: [{ id: "22222222-0000-4000-8000-000000000002", username: "a-b-11111111" }],
    });
    const before = accounts(db);

    expect(() => applyUsernameRewrite(db)).toThrow(/UNIQUE constraint failed: users.username/);

    expect(accounts(db)).toEqual(before);
  });
});
