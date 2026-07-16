import type {
  CollaborationInviteRole,
  CollaborationRole,
  CollaborationRoomStatus,
} from "../../src/collaboration/protocol";

export interface CollaborationRoomRow {
  id: string;
  owner_id: string;
  host_user_id: string;
  status: CollaborationRoomStatus;
  protocol_version: number;
  document_schema_version: number;
  role_version: number;
  max_members: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  purged_at: number | null;
}

export class CollaborationRoomQuotaError extends Error {
  constructor() {
    super("active collaboration room quota exceeded");
    this.name = "CollaborationRoomQuotaError";
  }
}

const MAX_ACTIVE_ROOMS_PER_OWNER = 5;

export interface CollaborationMemberRow {
  user_id: string;
  role: CollaborationRole;
  username: string;
  name: string | null;
  avatar_url: string | null;
  joined_at: number;
  updated_at: number;
}

export interface CollaborationInvitationRow {
  id: string;
  room_id: string;
  created_by: string;
  token_hash: string;
  role: CollaborationInviteRole;
  max_uses: number;
  use_count: number;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CollaborationRoomAccess extends CollaborationRoomRow {
  member_role: CollaborationRole;
}

export interface CreateCollaborationRoomParams {
  ownerId: string;
  protocolVersion: number;
  documentSchemaVersion: number;
}

export async function createProvisioningCollaborationRoom(
  db: D1Database,
  params: CreateCollaborationRoomParams,
): Promise<CollaborationRoomRow> {
  const activeRooms = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM collaboration_rooms
       WHERE owner_id = ? AND status IN ('provisioning', 'active')`,
    )
    .bind(params.ownerId)
    .first<{ count: number }>();
  if ((activeRooms?.count ?? 0) >= MAX_ACTIVE_ROOMS_PER_OWNER) {
    throw new CollaborationRoomQuotaError();
  }
  const now = Date.now();
  const room: CollaborationRoomRow = {
    id: crypto.randomUUID(),
    owner_id: params.ownerId,
    host_user_id: params.ownerId,
    status: "provisioning",
    protocol_version: params.protocolVersion,
    document_schema_version: params.documentSchemaVersion,
    role_version: 1,
    max_members: 10,
    created_at: now,
    updated_at: now,
    closed_at: null,
    purged_at: null,
  };

  await db.batch([
    db
      .prepare(
        `INSERT INTO collaboration_rooms
           (id, owner_id, host_user_id, status, protocol_version,
            document_schema_version, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        room.id,
        room.owner_id,
        room.host_user_id,
        room.status,
        room.protocol_version,
        room.document_schema_version,
        room.created_at,
        room.updated_at,
      ),
    db
      .prepare(
        `INSERT INTO collaboration_members
           (room_id, user_id, role, joined_at, updated_at)
         VALUES (?, ?, 'owner', ?, ?)`,
      )
      .bind(room.id, room.owner_id, now, now),
  ]);

  return room;
}

export async function getCollaborationRoomById(
  db: D1Database,
  roomId: string,
): Promise<CollaborationRoomRow | null> {
  const row = await db
    .prepare("SELECT * FROM collaboration_rooms WHERE id = ?")
    .bind(roomId)
    .first<CollaborationRoomRow>();
  return row ?? null;
}

export async function markCollaborationRoomPurged(
  db: D1Database,
  roomId: string,
  closedAt: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE collaboration_rooms
       SET purged_at = COALESCE(purged_at, ?), updated_at = ?
       WHERE id = ? AND status = 'closed' AND closed_at = ?`,
    )
    .bind(Date.now(), Date.now(), roomId, closedAt)
    .run();
  return result.meta.changes > 0;
}

export type CollaborationAuditAction =
  | "room.created"
  | "invitation.created"
  | "invitation.revoked"
  | "invitation.claimed"
  | "member.role_changed"
  | "member.removed"
  | "room.closed"
  | "room.exported"
  | "room.compacted"
  | "room.purged";

export async function recordCollaborationAuditEvent(
  db: D1Database,
  input: {
    roomId: string;
    actorUserId: string | null;
    action: CollaborationAuditAction;
    targetUserId?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO collaboration_audit_events
         (id, room_id, actor_user_id, action, target_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.roomId,
      input.actorUserId,
      input.action,
      input.targetUserId ?? null,
      Date.now(),
    )
    .run();
}

export async function setCollaborationRoomStatus(
  db: D1Database,
  roomId: string,
  status: CollaborationRoomStatus,
): Promise<CollaborationRoomRow | null> {
  const now = Date.now();
  const row = await db
    .prepare(
      `UPDATE collaboration_rooms
       SET status = ?, updated_at = ?, closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END
       WHERE id = ?
       RETURNING *`,
    )
    .bind(status, now, status, now, roomId)
    .first<CollaborationRoomRow>();
  return row ?? null;
}

export async function getCollaborationRoomAccess(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<CollaborationRoomAccess | null> {
  const row = await db
    .prepare(
      `SELECT rooms.*, members.role AS member_role
       FROM collaboration_rooms AS rooms
       JOIN collaboration_members AS members ON members.room_id = rooms.id
       WHERE rooms.id = ? AND members.user_id = ?`,
    )
    .bind(roomId, userId)
    .first<CollaborationRoomAccess>();
  return row ?? null;
}

export async function listCollaborationRoomsForUser(
  db: D1Database,
  userId: string,
): Promise<CollaborationRoomAccess[]> {
  const result = await db
    .prepare(
      `SELECT rooms.*, members.role AS member_role
       FROM collaboration_rooms AS rooms
       JOIN collaboration_members AS members ON members.room_id = rooms.id
       WHERE members.user_id = ?
       ORDER BY rooms.updated_at DESC
       LIMIT 100`,
    )
    .bind(userId)
    .all<CollaborationRoomAccess>();
  return result.results ?? [];
}

export async function listCollaborationRoomMembers(
  db: D1Database,
  roomId: string,
): Promise<CollaborationMemberRow[]> {
  const result = await db
    .prepare(
      `SELECT members.user_id, members.role, users.username, users.name, users.avatar_url,
              members.joined_at, members.updated_at
       FROM collaboration_members AS members
       JOIN users ON users.id = members.user_id
       WHERE members.room_id = ?
       ORDER BY CASE members.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                members.joined_at ASC`,
    )
    .bind(roomId)
    .all<CollaborationMemberRow>();
  return result.results ?? [];
}

export interface CreateCollaborationInvitationParams {
  roomId: string;
  createdBy: string;
  tokenHash: string;
  role: CollaborationInviteRole;
  maxUses: number;
  expiresAt: number;
}

export async function createCollaborationInvitation(
  db: D1Database,
  params: CreateCollaborationInvitationParams,
): Promise<CollaborationInvitationRow> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO collaboration_invitations
         (id, room_id, created_by, token_hash, role, max_uses, use_count,
          expires_at, revoked_at, created_at, updated_at)
       SELECT ?, rooms.id, ?, ?, ?, ?, 0, ?, NULL, ?, ?
       FROM collaboration_rooms AS rooms
       WHERE rooms.id = ? AND rooms.owner_id = ? AND rooms.status = 'active'
       RETURNING *`,
    )
    .bind(
      crypto.randomUUID(),
      params.createdBy,
      params.tokenHash,
      params.role,
      params.maxUses,
      params.expiresAt,
      now,
      now,
      params.roomId,
      params.createdBy,
    )
    .first<CollaborationInvitationRow>();
  if (!row) throw new Error("collaboration room is unavailable or not owned by this user");
  return row;
}

export async function listCollaborationInvitations(
  db: D1Database,
  roomId: string,
  ownerId: string,
): Promise<CollaborationInvitationRow[] | null> {
  const room = await db
    .prepare("SELECT 1 FROM collaboration_rooms WHERE id = ? AND owner_id = ?")
    .bind(roomId, ownerId)
    .first();
  if (!room) return null;
  const result = await db
    .prepare(
      `SELECT * FROM collaboration_invitations
       WHERE room_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    .bind(roomId)
    .all<CollaborationInvitationRow>();
  return result.results ?? [];
}

export async function revokeCollaborationInvitation(
  db: D1Database,
  roomId: string,
  invitationId: string,
  ownerId: string,
): Promise<boolean> {
  const now = Date.now();
  const result = await db
    .prepare(
      `UPDATE collaboration_invitations
       SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
       WHERE id = ? AND room_id = ? AND room_id IN (
         SELECT id FROM collaboration_rooms WHERE owner_id = ?
       )`,
    )
    .bind(now, now, invitationId, roomId, ownerId)
    .run();
  return result.meta.changes > 0;
}

export async function getCollaborationInvitationByHash(
  db: D1Database,
  tokenHash: string,
): Promise<CollaborationInvitationRow | null> {
  const row = await db
    .prepare(
      `SELECT invitations.*
       FROM collaboration_invitations AS invitations
       JOIN collaboration_rooms AS rooms ON rooms.id = invitations.room_id
       WHERE invitations.token_hash = ?
         AND invitations.revoked_at IS NULL
         AND invitations.expires_at > ?
         AND invitations.use_count < invitations.max_uses
         AND rooms.status = 'active'`,
    )
    .bind(tokenHash, Date.now())
    .first<CollaborationInvitationRow>();
  return row ?? null;
}

export async function claimCollaborationInvitation(
  db: D1Database,
  invitation: CollaborationInvitationRow,
  userId: string,
): Promise<CollaborationRoomAccess | null> {
  const existing = await getCollaborationRoomAccess(db, invitation.room_id, userId);
  if (existing) return existing;

  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO collaboration_invitation_claims (invitation_id, user_id, claimed_at)
         SELECT invitations.id, ?, ?
         FROM collaboration_invitations AS invitations
         JOIN collaboration_rooms AS rooms ON rooms.id = invitations.room_id
         WHERE invitations.id = ?
           AND invitations.token_hash = ?
           AND invitations.revoked_at IS NULL
           AND invitations.expires_at > ?
           AND invitations.use_count < invitations.max_uses
           AND rooms.status = 'active'
           AND (SELECT COUNT(*) FROM collaboration_members WHERE room_id = rooms.id)
               < rooms.max_members
         ON CONFLICT (invitation_id, user_id) DO NOTHING`,
      )
      .bind(userId, now, invitation.id, invitation.token_hash, now),
    db
      .prepare(
        `INSERT INTO collaboration_members (room_id, user_id, role, joined_at, updated_at)
         SELECT invitations.room_id, claims.user_id, invitations.role, claims.claimed_at, ?
         FROM collaboration_invitation_claims AS claims
         JOIN collaboration_invitations AS invitations ON invitations.id = claims.invitation_id
         WHERE claims.invitation_id = ? AND claims.user_id = ?
         ON CONFLICT (room_id, user_id) DO UPDATE SET
           role = CASE
             WHEN collaboration_members.role = 'owner' THEN 'owner'
             WHEN excluded.role = 'editor' THEN 'editor'
             ELSE collaboration_members.role
           END,
           updated_at = excluded.updated_at`,
      )
      .bind(now, invitation.id, userId),
    db
      .prepare(
        `UPDATE collaboration_invitations
         SET use_count = (
               SELECT COUNT(*) FROM collaboration_invitation_claims
               WHERE invitation_id = collaboration_invitations.id
             ),
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(now, invitation.id),
    db
      .prepare(
        `UPDATE collaboration_rooms
         SET role_version = role_version + 1, updated_at = ?
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM collaboration_members WHERE room_id = ? AND user_id = ?
         )`,
      )
      .bind(now, invitation.room_id, invitation.room_id, userId),
  ]);
  return getCollaborationRoomAccess(db, invitation.room_id, userId);
}

export async function updateCollaborationMemberRole(
  db: D1Database,
  roomId: string,
  ownerId: string,
  userId: string,
  role: CollaborationInviteRole,
): Promise<CollaborationMemberRow | null> {
  const target = await db
    .prepare(
      `SELECT members.role
       FROM collaboration_members AS members
       JOIN collaboration_rooms AS rooms ON rooms.id = members.room_id
       WHERE members.room_id = ? AND members.user_id = ? AND rooms.owner_id = ?`,
    )
    .bind(roomId, userId, ownerId)
    .first<{ role: CollaborationRole }>();
  if (!target || target.role === "owner") return null;

  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE collaboration_members
         SET role = ?, updated_at = ?
         WHERE room_id = ? AND user_id = ? AND role != 'owner'
           AND room_id IN (SELECT id FROM collaboration_rooms WHERE owner_id = ?)`,
      )
      .bind(role, now, roomId, userId, ownerId),
    db
      .prepare(
        `UPDATE collaboration_rooms
         SET role_version = role_version + 1, updated_at = ?
         WHERE id = ? AND owner_id = ?`,
      )
      .bind(now, roomId, ownerId),
  ]);
  return db
    .prepare(
      `SELECT members.user_id, members.role, users.username, users.name, users.avatar_url,
              members.joined_at, members.updated_at
       FROM collaboration_members AS members
       JOIN users ON users.id = members.user_id
       WHERE members.room_id = ? AND members.user_id = ?`,
    )
    .bind(roomId, userId)
    .first<CollaborationMemberRow>();
}

export async function removeCollaborationMember(
  db: D1Database,
  roomId: string,
  ownerId: string,
  userId: string,
): Promise<boolean> {
  const target = await db
    .prepare(
      `SELECT members.role
       FROM collaboration_members AS members
       JOIN collaboration_rooms AS rooms ON rooms.id = members.room_id
       WHERE members.room_id = ? AND members.user_id = ? AND rooms.owner_id = ?`,
    )
    .bind(roomId, userId, ownerId)
    .first<{ role: CollaborationRole }>();
  if (!target || target.role === "owner") return false;

  const now = Date.now();
  const [removed] = await db.batch([
    db
      .prepare(
        `DELETE FROM collaboration_members
         WHERE room_id = ? AND user_id = ? AND role != 'owner'
           AND room_id IN (SELECT id FROM collaboration_rooms WHERE owner_id = ?)`,
      )
      .bind(roomId, userId, ownerId),
    db
      .prepare(
        `UPDATE collaboration_rooms
         SET role_version = role_version + 1, updated_at = ?
         WHERE id = ? AND owner_id = ?`,
      )
      .bind(now, roomId, ownerId),
  ]);
  return removed.meta.changes > 0;
}
