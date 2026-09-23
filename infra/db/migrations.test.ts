// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Migration 0013 run against the real schema: every earlier migration is
 * applied first, in the order wrangler applies them, so its UPDATEs meet the
 * same tables and UNIQUE constraints as production does.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));
const RENAME_MIGRATION = "0013_rename_unreachable_slugs.sql";

const OWNER_ID = "00000000-0000-4000-8000-000000000000";

interface SluggedRow {
  id: string;
  slug: string;
  updatedAt: number;
}

function readMigration(name: string): string {
  return readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8");
}

/** A database at the schema just before 0013, holding the given rows. */
function databaseBeforeRename(rows: { lessons: SluggedRow[]; playlists: SluggedRow[] }) {
  const db = new DatabaseSync(":memory:");
  const earlier = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && name < RENAME_MIGRATION)
    .sort();
  for (const name of earlier) {
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
