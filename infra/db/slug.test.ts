import { describe, expect, it } from "vite-plus/test";
import { generateUniqueSlug, isSlugUniqueViolation, slugifyTitle } from "./slug";

/** D1 stand-in whose `lessons`/`playlists` tables hold the given slugs. */
function makeDb(taken: string[]) {
  const takenSet = new Set(taken);
  const probed: string[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(candidate: string) {
          probed.push(candidate);
          return {
            async first() {
              return takenSet.has(candidate) ? { 1: 1 } : null;
            },
          };
        },
        sql,
      };
      return statement;
    },
  };
  return { db: db as unknown as D1Database, probed };
}

describe("generateUniqueSlug", () => {
  it("prefers the bare slug and only suffixes on a real collision", async () => {
    const { db } = makeDb([]);
    await expect(generateUniqueSlug(db, "lessons", "my-lesson")).resolves.toBe("my-lesson");

    const { db: busy } = makeDb(["my-lesson", "my-lesson-1"]);
    await expect(generateUniqueSlug(busy, "lessons", "my-lesson")).resolves.toBe("my-lesson-2");
  });

  // Both lesson resolvers check the build-time seed manifest before D1, so a
  // slug the seed owns is unreachable for a D1 lesson no matter what D1 says.
  it("never hands out a slug the static seed catalog already answers for", async () => {
    const { db, probed } = makeDb([]);
    await expect(generateUniqueSlug(db, "lessons", "introduction")).resolves.toBe("introduction-1");
    expect(probed).not.toContain("introduction");
  });

  // GET /api/lessons/mine and GET /api/playlists/mine are registered before the
  // "/:slug" route and Hono dispatches in registration order, so a row whose slug
  // is "mine" could never be fetched through its own public URL.
  it.each(["lessons", "playlists"] as const)(
    "never hands a %s row the slug the owner-library route answers for",
    async (table) => {
      const { db, probed } = makeDb([]);
      await expect(generateUniqueSlug(db, table, "mine")).resolves.toBe("mine-1");
      expect(probed).not.toContain("mine");
    },
  );

  it("does not reserve lesson slugs for playlists", async () => {
    const { db } = makeDb([]);
    await expect(generateUniqueSlug(db, "playlists", "introduction")).resolves.toBe("introduction");
  });

  // A long run of same-titled rows used to make every later create walk the
  // whole series, one D1 round-trip per probe, with no ceiling at all.
  it("stops probing and falls back to a random suffix on a long collision run", async () => {
    const taken = ["dup", ...Array.from({ length: 60 }, (_, i) => `dup-${i + 1}`)];
    const { db, probed } = makeDb(taken);

    const slug = await generateUniqueSlug(db, "lessons", "dup");

    expect(slug).toMatch(/^dup-[0-9a-f]{8}$/);
    expect(probed.length).toBeLessThanOrEqual(51);
  });
});

describe("slugifyTitle", () => {
  it("joins lowercase letters and digits with single hyphens", () => {
    expect(slugifyTitle("  Hello, World! Part 2  ", "lesson")).toBe("hello-world-part-2");
  });

  it("falls back when the title has no ASCII letters or digits", () => {
    expect(slugifyTitle("မင်္ဂလာပါ", "lesson")).toBe("lesson");
    expect(slugifyTitle("", "playlist")).toBe("playlist");
  });

  it("caps the slug at 60 characters", () => {
    expect(slugifyTitle("a".repeat(80), "lesson")).toBe("a".repeat(60));
  });

  // The cut used to run after the hyphen trim, so a cut landing on a hyphen
  // kept it at the end of the slug.
  it("never ends in a hyphen when the cut lands on one", () => {
    expect(slugifyTitle(`${"a".repeat(59)} b`, "lesson")).toBe("a".repeat(59));
  });
});

describe("isSlugUniqueViolation", () => {
  it("matches only the slug column of the named table", () => {
    const error = new Error("D1_ERROR: UNIQUE constraint failed: lessons.slug: SQLITE_CONSTRAINT");

    expect(isSlugUniqueViolation(error, "lessons")).toBe(true);
    expect(isSlugUniqueViolation(error, "playlists")).toBe(false);
    expect(
      isSlugUniqueViolation(new Error("UNIQUE constraint failed: lessons.id"), "lessons"),
    ).toBe(false);
  });
});
