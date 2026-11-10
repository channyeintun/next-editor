import type {
  CollaborationRole,
  CollaborationRoomControlCommand,
} from "../../../src/collaboration/protocol";
import type { RoomSqliteStorage } from "./roomSqliteDocumentStore";

// The row that records a room-closed control. Member rows are keyed by user
// ID, a UUID, so this never collides with one.
const ROOM_TARGET = "room";

/** What a socket upgrade may become once the membership changes already applied are counted. */
export type MembershipAdmission =
  | { admitted: true; role: CollaborationRole; roleVersion: number }
  | { admitted: false; reason: "removed" | "room-closed" };

/**
 * The membership changes a room or voice object has applied, kept in its own
 * storage. Shared by both objects.
 *
 * The Worker reads D1 once for a socket upgrade and forwards that snapshot. A
 * removal can commit after the read while its /control reaches the object
 * before the upgrade does; /control closes only the sockets open at that
 * moment, so without this record the late upgrade was accepted with the access
 * the member had just lost. Every membership change raises the room-wide
 * role_version, so a snapshot older than a recorded change predates it.
 */
export class AppliedMembershipChanges {
  private readonly storage: RoomSqliteStorage;

  constructor(storage: RoomSqliteStorage) {
    this.storage = storage;
  }

  /** Records a control command the object has just applied. A null role is a removal. */
  record(command: CollaborationRoomControlCommand): void {
    const { event } = command;
    if (event.kind === "room-closed") {
      this.write(ROOM_TARGET, event.roleVersion, null);
      return;
    }
    if (event.targetUserId === null || command.targetRole === undefined) return;
    this.write(event.targetUserId, event.roleVersion, command.targetRole);
  }

  /** The access a session whose D1 read saw `roleVersion` holds after the recorded changes. */
  admit(userId: string, role: CollaborationRole, roleVersion: number): MembershipAdmission {
    this.ensureTable();
    const rows = this.storage.sql
      .exec<{ target: string; role_version: number; role: CollaborationRole | null }>(
        "SELECT target, role_version, role FROM collaboration_applied_membership WHERE target IN (?, ?)",
        ROOM_TARGET,
        userId,
      )
      .toArray();
    // A closed room never reopens, whatever version the session read.
    if (rows.some((row) => row.target === ROOM_TARGET)) {
      return { admitted: false, reason: "room-closed" };
    }
    const change = rows.find((row) => row.target === userId);
    if (!change || roleVersion >= change.role_version) {
      return { admitted: true, role, roleVersion };
    }
    if (change.role === null) return { admitted: false, reason: "removed" };
    return { admitted: true, role: change.role, roleVersion: change.role_version };
  }

  // Commands can arrive out of order; an older one never replaces a newer row.
  private write(target: string, roleVersion: number, role: CollaborationRole | null): void {
    this.ensureTable();
    this.storage.sql.exec(
      `INSERT INTO collaboration_applied_membership (target, role_version, role)
       VALUES (?, ?, ?)
       ON CONFLICT(target) DO UPDATE SET role_version = excluded.role_version, role = excluded.role
       WHERE excluded.role_version >= collaboration_applied_membership.role_version`,
      target,
      roleVersion,
      role,
    );
  }

  // Created on use, not once: a room's purge deletes all of its storage, and
  // the owner can still repeat a close (a /control) afterwards.
  private ensureTable(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_applied_membership (
        target TEXT PRIMARY KEY,
        role_version INTEGER NOT NULL,
        role TEXT
      );
    `);
  }
}
