import type {
  CollaborationAssetDescriptor,
  CollaborationCreateRoomInput,
  CollaborationTeachingInitializationInput,
  CollaborationInviteRole,
  CollaborationInvitation,
  CollaborationMember,
  CollaborationRoomSession,
  CreatedCollaborationInvitation,
} from "../../../src/collaboration/protocol";
import {
  MAX_COLLABORATION_ASSET_BYTES,
  collaborationAssetDescriptorSchema,
} from "../../../src/collaboration/protocol";
import { apiClient } from "../apiClient";

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createCollaborationRoom(
  initialSnapshot: CollaborationCreateRoomInput,
): Promise<CollaborationRoomSession> {
  const response = await apiClient.post<CollaborationRoomSession>(
    "/collaboration/rooms",
    initialSnapshot,
  );
  return response.data;
}

export async function getCollaborationRoom(roomId: string): Promise<CollaborationRoomSession> {
  const response = await apiClient.get<CollaborationRoomSession>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}`,
    { headers: { "Cache-Control": "no-cache" } },
  );
  return response.data;
}

export async function initializeCollaborationTeachingSurfaces(
  roomId: string,
  update: CollaborationTeachingInitializationInput,
): Promise<void> {
  await apiClient.post(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/teaching/initialize`,
    update,
  );
}

export async function listCollaborationRooms(): Promise<CollaborationRoomSession[]> {
  const response = await apiClient.get<{ rooms: CollaborationRoomSession[] }>(
    "/collaboration/rooms",
  );
  return response.data.rooms;
}

export async function listCollaborationMembers(
  roomId: string,
): Promise<{ members: CollaborationMember[]; roleVersion: number }> {
  const response = await apiClient.get<{ members: CollaborationMember[]; roleVersion: number }>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/members`,
  );
  return response.data;
}

export async function listCollaborationInvitations(
  roomId: string,
): Promise<CollaborationInvitation[]> {
  const response = await apiClient.get<{ invitations: CollaborationInvitation[] }>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/invitations`,
  );
  return response.data.invitations;
}

export async function createCollaborationInvitation(
  roomId: string,
  input: { role: CollaborationInviteRole; expiresInHours?: number; maxUses?: number },
): Promise<CreatedCollaborationInvitation> {
  const response = await apiClient.post<CreatedCollaborationInvitation>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/invitations`,
    {
      role: input.role,
      expiresInHours: input.expiresInHours ?? 24,
      maxUses: input.maxUses ?? 10,
    },
  );
  return response.data;
}

export async function revokeCollaborationInvitation(
  roomId: string,
  invitationId: string,
): Promise<void> {
  await apiClient.delete(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/invitations/${encodeURIComponent(invitationId)}`,
  );
}

export async function claimCollaborationInvitation(
  token: string,
): Promise<CollaborationRoomSession> {
  const response = await apiClient.post<CollaborationRoomSession>(
    "/collaboration/invitations/claim",
    { token },
  );
  return response.data;
}

export async function updateCollaborationMemberRole(
  roomId: string,
  userId: string,
  role: CollaborationInviteRole,
): Promise<CollaborationMember> {
  const response = await apiClient.patch<{ member: CollaborationMember }>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`,
    { role },
  );
  return response.data.member;
}

export async function removeCollaborationMember(roomId: string, userId: string): Promise<void> {
  await apiClient.delete(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`,
  );
}

export async function closeCollaborationRoom(roomId: string): Promise<CollaborationRoomSession> {
  const response = await apiClient.post<CollaborationRoomSession>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/close`,
  );
  return response.data;
}

export async function exportCollaborationRoom(roomId: string): Promise<Blob> {
  const response = await apiClient.get<Blob>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/export`,
    { responseType: "blob" },
  );
  return response.data;
}

export async function uploadCollaborationAsset(
  roomId: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<CollaborationAssetDescriptor> {
  if (bytes.byteLength === 0) throw new Error("A collaboration asset cannot be empty.");
  if (bytes.byteLength > MAX_COLLABORATION_ASSET_BYTES) {
    throw new Error("A collaboration asset cannot exceed 5 MB.");
  }
  const id = await sha256Hex(bytes);
  const response = await apiClient.put<CollaborationAssetDescriptor>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/assets/${id}`,
    exactArrayBuffer(bytes),
    { headers: { "Content-Type": mimeType || "application/octet-stream" } },
  );
  const asset = collaborationAssetDescriptorSchema.parse(response.data);
  const expectedMimeType = mimeType || "application/octet-stream";
  if (asset.id !== id || asset.mimeType !== expectedMimeType || asset.size !== bytes.byteLength) {
    throw new Error("The uploaded collaboration asset failed its integrity check.");
  }
  return asset;
}

export async function downloadCollaborationAsset(
  roomId: string,
  assetId: string,
): Promise<Uint8Array> {
  const response = await apiClient.get<ArrayBuffer>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/assets/${encodeURIComponent(assetId)}`,
    { responseType: "arraybuffer" },
  );
  const bytes = new Uint8Array(response.data);
  if ((await sha256Hex(bytes)) !== assetId) {
    throw new Error("The downloaded collaboration asset failed its integrity check.");
  }
  return bytes;
}
