// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CollaborationInviteRole } from "../../src/collaboration/protocol";
import {
  claimCollaborationInvitation,
  CollaborationRoomQuotaError,
  createCollaborationInvitation,
  createProvisioningCollaborationRoom,
  removeCollaborationMember,
  setCollaborationRoomStatus,
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

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

const OWNER_ID = "owner";
const VIEWER_ID = "viewer";
const NEWCOMER_ID = "newcomer";

interface CollaborationDb {
  db: D1Database;
  sqlite: DatabaseSync;
  /**
   * Runs `write` just before the next batch starts, where another request's
   * commit can land after this request's pre-reads.
   */
  beforeNextBatch(write: () => void): void;
}

/**
 * A database at the production schema: every migration applied in the order
 * wrangler applies them, with foreign keys enforced as D1 enforces them. The
 * D1 stand-in runs a batch as one transaction, as D1 does.
 */
function openCollaborationDb(): CollaborationDb {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    sqlite.exec(readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8"));
  }

  let pendingWrite: (() => void) | null = null;

  function statement(sql: string, args: unknown[] = []) {
    const run = () => {
      const result = sqlite.prepare(sql).run(...(args as never[]));
      return { meta: { changes: Number(result.changes) } };
    };
    return {
      bind: (...bound: unknown[]) => statement(sql, bound),
      first: async () => sqlite.prepare(sql).get(...(args as never[])) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
      run: async () => run(),
      runNow: run,
    };
  }

  async function batch(statements: Array<ReturnType<typeof statement>>) {
    const write = pendingWrite;
    pendingWrite = null;
    write?.();
    sqlite.exec("BEGIN");
    try {
      const results = statements.map((entry) => entry.runNow());
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    db: { prepare: (sql: string) => statement(sql), batch } as unknown as D1Database,
    sqlite,
    beforeNextBatch(write) {
      pendingWrite = write;
    },
  };
}

/** An active room owned by OWNER_ID, with an unused viewer and editor invitation. */
async function openRoom({ db, sqlite }: CollaborationDb) {
  const insertUser = sqlite.prepare(
    "INSERT INTO users (id, google_sub, email, username, created_at) VALUES (?, ?, ?, ?, 0)",
  );
  for (const id of [OWNER_ID, VIEWER_ID, NEWCOMER_ID]) {
    insertUser.run(id, `google-${id}`, `${id}@example.com`, id);
  }

  const room = await createProvisioningCollaborationRoom(db, { ownerId: OWNER_ID });
  await setCollaborationRoomStatus(db, room.id, "active");
  const invite = (role: CollaborationInviteRole) =>
    createCollaborationInvitation(db, {
      roomId: room.id,
      createdBy: OWNER_ID,
      tokenHash: `${role}-token-hash`,
      role,
      maxUses: 10,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
  return {
    roomId: room.id,
    viewerInvitation: await invite("viewer"),
    editorInvitation: await invite("editor"),
  };
}

function limitRoomTo(sqlite: DatabaseSync, roomId: string, maxMembers: number): void {
  sqlite
    .prepare("UPDATE collaboration_rooms SET max_members = ? WHERE id = ?")
    .run(maxMembers, roomId);
}

function memberCount(sqlite: DatabaseSync, roomId: string): number {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS count FROM collaboration_members WHERE room_id = ?")
    .get(roomId) as { count: number };
  return row.count;
}

function isMember(sqlite: DatabaseSync, roomId: string, userId: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM collaboration_members WHERE room_id = ? AND user_id = ?")
    .get(roomId, userId);
  return row !== undefined;
}

function roleVersion(sqlite: DatabaseSync, roomId: string): number {
  const row = sqlite
    .prepare("SELECT role_version FROM collaboration_rooms WHERE id = ?")
    .get(roomId) as { role_version: number };
  return row.role_version;
}

function useCount(sqlite: DatabaseSync, invitationId: string): number {
  const row = sqlite
    .prepare("SELECT use_count FROM collaboration_invitations WHERE id = ?")
    .get(invitationId) as { use_count: number };
  return row.use_count;
}

function hasClaimed(sqlite: DatabaseSync, invitationId: string, userId: string): boolean {
  const row = sqlite
    .prepare(
      "SELECT 1 FROM collaboration_invitation_claims WHERE invitation_id = ? AND user_id = ?",
    )
    .get(invitationId, userId);
  return row !== undefined;
}

describe("claimCollaborationInvitation", () => {
  it("admits a first-time claimant once, recording one claim and spending one use", async () => {
    const database = openCollaborationDb();
    const { db, sqlite } = database;
    const { roomId, editorInvitation } = await openRoom(database);
    const versionBefore = roleVersion(sqlite, roomId);

    const access = await claimCollaborationInvitation(db, editorInvitation, VIEWER_ID);

    expect(access?.member_role).toBe("editor");
    expect(hasClaimed(sqlite, editorInvitation.id, VIEWER_ID)).toBe(true);
    expect(useCount(sqlite, editorInvitation.id)).toBe(1);
    expect(roleVersion(sqlite, roomId)).toBe(versionBefore + 1);
  });

  // An invitation admits people. Changing what a member may do is the owner's
  // call, through updateCollaborationMemberRole, so a viewer the owner demoted
  // cannot promote themselves with an editor link that is still valid.
  it("leaves an existing viewer a viewer when they claim an editor invitation, spending none of its uses", async () => {
    const database = openCollaborationDb();
    const { db, sqlite } = database;
    const { roomId, viewerInvitation, editorInvitation } = await openRoom(database);
    await claimCollaborationInvitation(db, viewerInvitation, VIEWER_ID);
    const versionBefore = roleVersion(sqlite, roomId);

    const access = await claimCollaborationInvitation(db, editorInvitation, VIEWER_ID);

    expect(access?.member_role).toBe("viewer");
    expect(hasClaimed(sqlite, editorInvitation.id, VIEWER_ID)).toBe(false);
    expect(useCount(sqlite, editorInvitation.id)).toBe(0);
    expect(roleVersion(sqlite, roomId)).toBe(versionBefore);
  });

  // The membership check and the batch are separate D1 round-trips, so a
  // concurrent claim can admit the user in between. The batch has to apply the
  // same rule as the check, or this path upgrades the role the check protects.
  it("leaves a member who joined between the membership check and the batch as they are", async () => {
    const database = openCollaborationDb();
    const { db, sqlite } = database;
    const { roomId, viewerInvitation, editorInvitation } = await openRoom(database);
    database.beforeNextBatch(() => {
      sqlite
        .prepare(
          `INSERT INTO collaboration_members (room_id, user_id, role, joined_at, updated_at)
           VALUES (?, ?, 'viewer', 1, 1)`,
        )
        .run(roomId, VIEWER_ID);
      sqlite
        .prepare(
          `INSERT INTO collaboration_invitation_claims (invitation_id, user_id, claimed_at)
           VALUES (?, ?, 1)`,
        )
        .run(viewerInvitation.id, VIEWER_ID);
    });
    const versionBefore = roleVersion(sqlite, roomId);

    const access = await claimCollaborationInvitation(db, editorInvitation, VIEWER_ID);

    expect(access?.member_role).toBe("viewer");
    expect(hasClaimed(sqlite, editorInvitation.id, VIEWER_ID)).toBe(false);
    expect(useCount(sqlite, editorInvitation.id)).toBe(0);
    expect(roleVersion(sqlite, roomId)).toBe(versionBefore);
  });

  // Removing a member deletes their membership but keeps their claim, and the
  // claim is what stops the invitation that admitted them from admitting them
  // again. Otherwise "Remove" would last only until they reopened their link.
  it("refuses a removed member who re-presents the invitation that admitted them", async () => {
    const database = openCollaborationDb();
    const { db, sqlite } = database;
    const { roomId, viewerInvitation } = await openRoom(database);
    await claimCollaborationInvitation(db, viewerInvitation, VIEWER_ID);
    await removeCollaborationMember(db, roomId, OWNER_ID, VIEWER_ID);
    const versionBefore = roleVersion(sqlite, roomId);

    const access = await claimCollaborationInvitation(db, viewerInvitation, VIEWER_ID);

    expect(access).toBeNull();
    expect(isMember(sqlite, roomId, VIEWER_ID)).toBe(false);
    expect(useCount(sqlite, viewerInvitation.id)).toBe(1);
    expect(roleVersion(sqlite, roomId)).toBe(versionBefore);
  });

  it("does not re-admit a removed member past max_members", async () => {
    const database = openCollaborationDb();
    const { db, sqlite } = database;
    const { roomId, viewerInvitation, editorInvitation } = await openRoom(database);
    limitRoomTo(sqlite, roomId, 2);
    await claimCollaborationInvitation(db, viewerInvitation, VIEWER_ID);
    await removeCollaborationMember(db, roomId, OWNER_ID, VIEWER_ID);
    await claimCollaborationInvitation(db, editorInvitation, NEWCOMER_ID);

    const access = await claimCollaborationInvitation(db, viewerInvitation, VIEWER_ID);

    expect(access).toBeNull();
    expect(memberCount(sqlite, roomId)).toBe(2);
  });

  // This is how the owner lets a removed member back in: a link they have
  // never used admits them like anyone else.
  it("admits a removed member through a new invitation, spending a seat and a use", async () => {
    const database = openCollaborationDb();
    const { db, sqlite } = database;
    const { roomId, viewerInvitation, editorInvitation } = await openRoom(database);
    await claimCollaborationInvitation(db, viewerInvitation, VIEWER_ID);
    await removeCollaborationMember(db, roomId, OWNER_ID, VIEWER_ID);

    const access = await claimCollaborationInvitation(db, editorInvitation, VIEWER_ID);

    expect(access?.member_role).toBe("editor");
    expect(memberCount(sqlite, roomId)).toBe(2);
    expect(useCount(sqlite, editorInvitation.id)).toBe(1);
  });

  it("refuses a claim when the room is full", async () => {
    const database = openCollaborationDb();
    const { db, sqlite } = database;
    const { roomId, viewerInvitation, editorInvitation } = await openRoom(database);
    limitRoomTo(sqlite, roomId, 2);
    await claimCollaborationInvitation(db, viewerInvitation, VIEWER_ID);

    const access = await claimCollaborationInvitation(db, editorInvitation, NEWCOMER_ID);

    expect(access).toBeNull();
    expect(memberCount(sqlite, roomId)).toBe(2);
    expect(useCount(sqlite, editorInvitation.id)).toBe(0);
  });
});
