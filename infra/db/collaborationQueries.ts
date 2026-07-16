import type { CollaborationRole, CollaborationRoomStatus } from "../../src/collaboration/protocol";

export interface CollaborationRoomRow {
  id: string;
  owner_id: string;
  host_user_id: string;
  status: CollaborationRoomStatus;
  protocol_version: number;
  document_schema_version: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
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
  const now = Date.now();
  const room: CollaborationRoomRow = {
    id: crypto.randomUUID(),
    owner_id: params.ownerId,
    host_user_id: params.ownerId,
    status: "provisioning",
    protocol_version: params.protocolVersion,
    document_schema_version: params.documentSchemaVersion,
    created_at: now,
    updated_at: now,
    closed_at: null,
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
