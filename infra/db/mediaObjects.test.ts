// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import {
  forgetMediaObject,
  forgetMediaObjectsUnder,
  releaseMediaObject,
  reserveMediaObject,
} from "./mediaObjects";
import { MAX_MEDIA_BYTES_PER_OWNER, MAX_MEDIA_OBJECTS_PER_OWNER } from "./ownerLimits";
import { insertSignedInUser, openSqliteD1 } from "./testing";

/** The storage quota's bookkeeping against real SQLite at the production schema. */
function createDb() {
  const opened = openSqliteD1();
  insertSignedInUser(opened.sqlite, "ada", "session-ada");
  insertSignedInUser(opened.sqlite, "grace", "session-grace");
  return opened;
}

function rows(sqlite: ReturnType<typeof openSqliteD1>["sqlite"]) {
  return sqlite.prepare("SELECT key, owner_id, bytes FROM media_objects ORDER BY key").all();
}

describe("reserveMediaObject", () => {
  it("records an object, and a re-upload replaces its size instead of adding to it", async () => {
    const { db, sqlite } = createDb();

    expect(await reserveMediaObject(db, "lessons/a/a.ne", "ada", 10)).toEqual({
      kind: "reserved",
      previousBytes: null,
    });
    expect(await reserveMediaObject(db, "lessons/a/a.ne", "ada", 7)).toEqual({
      kind: "reserved",
      previousBytes: 10,
    });

    expect(rows(sqlite)).toEqual([{ key: "lessons/a/a.ne", owner_id: "ada", bytes: 7 }]);
  });

  it("admits bytes only while the owner's other objects plus this one fit", async () => {
    const { db } = createDb();
    await reserveMediaObject(db, "lessons/a/big.webm", "ada", MAX_MEDIA_BYTES_PER_OWNER - 10);

    expect((await reserveMediaObject(db, "lessons/a/a.ne", "ada", 10)).kind).toBe("reserved");
    expect(await reserveMediaObject(db, "lessons/a/b.ne", "ada", 1)).toEqual({
      kind: "over_quota",
    });
    // Shrinking a file it already has always fits; the quota is per owner.
    expect((await reserveMediaObject(db, "lessons/a/a.ne", "ada", 9)).kind).toBe("reserved");
    expect((await reserveMediaObject(db, "lessons/g/g.ne", "grace", 10)).kind).toBe("reserved");
  });

  it("admits at most MAX_MEDIA_OBJECTS_PER_OWNER objects", async () => {
    const { db, sqlite } = createDb();
    const insert = sqlite.prepare(
      "INSERT INTO media_objects (key, owner_id, bytes, created_at, updated_at) VALUES (?, 'ada', 1, 0, 0)",
    );
    for (let index = 0; index < MAX_MEDIA_OBJECTS_PER_OWNER; index++) {
      insert.run(`lessons/seed/${index}.ne`);
    }

    expect(await reserveMediaObject(db, "lessons/a/one-more.ne", "ada", 1)).toEqual({
      kind: "over_quota",
    });
    expect((await reserveMediaObject(db, "lessons/seed/0.ne", "ada", 2)).kind).toBe("reserved");
  });

  it("never hands one owner's key to another", async () => {
    const { db, sqlite } = createDb();
    await reserveMediaObject(db, "lessons/a/a.ne", "ada", 10);

    expect(await reserveMediaObject(db, "lessons/a/a.ne", "grace", 1)).toEqual({ kind: "taken" });
    expect(rows(sqlite)).toEqual([{ key: "lessons/a/a.ne", owner_id: "ada", bytes: 10 }]);
  });
});

describe("releaseMediaObject and forgetting", () => {
  it("puts back what a failed write's key held before", async () => {
    const { db, sqlite } = createDb();
    await reserveMediaObject(db, "lessons/a/a.ne", "ada", 10);
    const replacing = await reserveMediaObject(db, "lessons/a/a.ne", "ada", 99);
    const fresh = await reserveMediaObject(db, "lessons/a/b.ne", "ada", 5);

    if (replacing.kind !== "reserved" || fresh.kind !== "reserved") throw new Error("reserved");
    await releaseMediaObject(db, "lessons/a/a.ne", "ada", replacing.previousBytes);
    await releaseMediaObject(db, "lessons/a/b.ne", "ada", fresh.previousBytes);

    expect(rows(sqlite)).toEqual([{ key: "lessons/a/a.ne", owner_id: "ada", bytes: 10 }]);
  });

  it("forgets the owner's objects under a lesson's prefix, and nothing beside it", async () => {
    const { db, sqlite } = createDb();
    for (const key of [
      "lessons/a_1/a.ne",
      "lessons/a_1/a-thumbnail-1.webp",
      "lessons/a_1-2/x.ne",
      "lessons/a_10/x.ne",
      "lessons/a_1.x/x.ne",
      "lessons/ab1/x.ne",
    ]) {
      await reserveMediaObject(db, key, "ada", 1);
    }
    await reserveMediaObject(db, "lessons/a_1/g.ne", "grace", 1);

    await forgetMediaObjectsUnder(db, "lessons/a_1/", "ada");
    await forgetMediaObject(db, "lessons/ab1/x.ne", "ada");

    expect(rows(sqlite)).toEqual([
      { key: "lessons/a_1-2/x.ne", owner_id: "ada", bytes: 1 },
      { key: "lessons/a_1.x/x.ne", owner_id: "ada", bytes: 1 },
      { key: "lessons/a_1/g.ne", owner_id: "grace", bytes: 1 },
      { key: "lessons/a_10/x.ne", owner_id: "ada", bytes: 1 },
    ]);
  });
});
