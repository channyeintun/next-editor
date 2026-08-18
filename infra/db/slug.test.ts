import { describe, expect, it } from "vitest";
import { generateUniqueSlug } from "./slug";

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
