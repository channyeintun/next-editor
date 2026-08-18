import { describe, expect, it } from "vitest";
import {
  CollaborationRoomQuotaError,
  createProvisioningCollaborationRoom,
} from "./collaborationQueries";

interface RecordedStatement {
  sql: string;
  args: unknown[];
}

/**
 * Minimal D1 stand-in: records every prepared statement and lets a test decide
 * how many rows the room INSERT reports changing, which is the only signal the
 * quota guard reads.
 */
function makeDb(options: { preReadCount: number; roomInsertChanges: number }) {
  const statements: RecordedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          statements.push({ sql, args });
          return statement;
        },
        async first<T>() {
          return { count: options.preReadCount } as T;
        },
      };
      return statement;
    },
    async batch() {
      return [
        { meta: { changes: options.roomInsertChanges } },
        { meta: { changes: options.roomInsertChanges } },
      ];
    },
  };
  return { db: db as unknown as D1Database, statements };
}

describe("createProvisioningCollaborationRoom", () => {
  it("rejects on the cheap pre-read when the owner is already at the cap", async () => {
    const { db } = makeDb({ preReadCount: 5, roomInsertChanges: 1 });
    await expect(createProvisioningCollaborationRoom(db, { ownerId: "u1" })).rejects.toBeInstanceOf(
      CollaborationRoomQuotaError,
    );
  });

  // The pre-read and the INSERT are separate round-trips, so concurrent creates
  // all see the same pre-insert count. The cap has to be enforced by the INSERT
  // itself or every racing request commits.
  it("carries the quota predicate inside the room INSERT", async () => {
    const { db, statements } = makeDb({ preReadCount: 0, roomInsertChanges: 1 });
    await createProvisioningCollaborationRoom(db, { ownerId: "u1" });

    const roomInsert = statements.find((s) => s.sql.includes("INSERT INTO collaboration_rooms"));
    expect(roomInsert?.sql).toContain("SELECT COUNT(*) FROM collaboration_rooms");
    expect(roomInsert?.sql).toContain("status IN ('provisioning', 'active')");
    expect(roomInsert?.args.slice(-2)).toEqual(["u1", 5]);
  });

  // collaboration_members.room_id has a foreign key onto collaboration_rooms, so
  // binding the id directly would trip the constraint and roll the batch back
  // with an opaque D1 error whenever the quota predicate suppressed the room.
  it("derives the owner member row from the room that was actually inserted", async () => {
    const { db, statements } = makeDb({ preReadCount: 0, roomInsertChanges: 1 });
    await createProvisioningCollaborationRoom(db, { ownerId: "u1" });

    const memberInsert = statements.find((s) =>
      s.sql.includes("INSERT INTO collaboration_members"),
    );
    expect(memberInsert?.sql).toContain("FROM collaboration_rooms WHERE id = ?");
    expect(memberInsert?.sql).not.toContain("VALUES");
  });

  it("reports the quota error when the INSERT guard suppressed the room", async () => {
    const { db } = makeDb({ preReadCount: 0, roomInsertChanges: 0 });
    await expect(createProvisioningCollaborationRoom(db, { ownerId: "u1" })).rejects.toBeInstanceOf(
      CollaborationRoomQuotaError,
    );
  });
});
