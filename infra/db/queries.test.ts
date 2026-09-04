import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { listPublishedLessons } from "./queries";

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

/** The lessons columns this query touches, per migrations/0001_init.sql. */
function createDb(rows: Array<{ id: string; publishedAt: number; status?: string }>) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE lessons (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      published_at INTEGER
    );
    CREATE INDEX idx_lessons_published ON lessons(status, published_at DESC);
  `);
  const insert = db.prepare(
    "INSERT INTO lessons (id, slug, status, published_at) VALUES (?,?,?,?)",
  );
  for (const row of rows) {
    insert.run(row.id, `slug-${row.id}`, row.status ?? "published", row.publishedAt);
  }
  return db;
}

/** Just enough of the D1 surface for the statements this module issues. */
function asD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          bound = args;
          return statement;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...(bound as never[])) as T[] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
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
    const db = asD1(createDb(ROWS));

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
    const natural = asD1(createDb(ROWS));
    const shuffled = asD1(createDb([...ROWS].reverse()));

    const fromNatural = (await listPublishedLessons(natural, 0, 10)).rows.map((row) => row.slug);
    const fromShuffled = (await listPublishedLessons(shuffled, 0, 10)).rows.map((row) => row.slug);

    expect(fromNatural).toEqual(fromShuffled);
  });

  it("never repeats or drops a lesson when two pages disagree about a tie", async () => {
    // Page 0 and page 1 are separate requests and may be served from different
    // cache entries or replicas. Model that worst case directly: fetch each
    // page from a database whose tied rows are stored the other way round.
    const forPageZero = asD1(createDb(ROWS));
    const forPageOne = asD1(createDb([ROWS[0], ROWS[1], ROWS[3], ROWS[2], ROWS[4], ROWS[5]]));

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
    const db = asD1(
      createDb([
        { id: "p1", publishedAt: 3 },
        { id: "p2", publishedAt: 2 },
        { id: "d1", publishedAt: 1, status: "draft" },
      ]),
    );

    const page = await listPublishedLessons(db, 0, 12);

    expect(page.rows.map((row) => row.slug)).toEqual(["slug-p1", "slug-p2"]);
    expect(page.nextPage).toBeNull();
  });
});
