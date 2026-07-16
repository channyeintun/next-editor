import type {
  CollaborationAssetDescriptor,
  CollaborationAwarenessEvent,
  CollaborationAwarenessInput,
  CollaborationBootstrapResponse,
  CollaborationCreateRoomInput,
  CollaborationDocumentUpdateInput,
  CollaborationInviteRole,
  CollaborationInvitation,
  CollaborationMember,
  CollaborationRoomSession,
  CollaborationUpdateAccepted,
  CreatedCollaborationInvitation,
} from "../../../src/collaboration/protocol";
import {
  MAX_COLLABORATION_ASSET_BYTES,
  collaborationAssetDescriptorSchema,
} from "../../../src/collaboration/protocol";
import { apiClient } from "../apiClient";

const BASE64_CHUNK_BYTES = 0x8000;

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function decodeBase64Asset(content: string): Uint8Array {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64Asset(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
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
  );
  return response.data;
}

export async function listCollaborationRooms(): Promise<CollaborationRoomSession[]> {
  const response = await apiClient.get<{ rooms: CollaborationRoomSession[] }>(
    "/collaboration/rooms",
  );
  return response.data.rooms;
}

export async function getCollaborationBootstrap(
  roomId: string,
  cursor?: string,
): Promise<CollaborationBootstrapResponse> {
  const response = await apiClient.get<CollaborationBootstrapResponse>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/bootstrap`,
    { params: cursor ? { cursor } : undefined },
  );
  return response.data;
}

export async function listCollaborationMembers(
  roomId: string,
): Promise<{ members: CollaborationMember[]; roleVersion: number }> {
  const response = await apiClient.get<{ members: CollaborationMember[]; roleVersion: number }>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/members`,
  );
  return response.data;
}

export async function listCollaborationAwareness(
  roomId: string,
): Promise<CollaborationAwarenessEvent[]> {
  const response = await apiClient.get<{ participants: CollaborationAwarenessEvent[] }>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/awareness`,
  );
  return response.data.participants;
}

export async function publishCollaborationAwareness(
  roomId: string,
  awareness: CollaborationAwarenessInput,
): Promise<{ accepted: true; streamId: string; event: CollaborationAwarenessEvent }> {
  const response = await apiClient.post<{
    accepted: true;
    streamId: string;
    event: CollaborationAwarenessEvent;
  }>(`/collaboration/rooms/${encodeURIComponent(roomId)}/awareness`, awareness);
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

export async function publishCollaborationUpdate(
  roomId: string,
  update: CollaborationDocumentUpdateInput,
): Promise<CollaborationUpdateAccepted> {
  const response = await apiClient.post<CollaborationUpdateAccepted>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/updates`,
    update,
  );
  return response.data;
}

export async function uploadCollaborationAsset(
  roomId: string,
  content: string,
  mimeType: string,
): Promise<CollaborationAssetDescriptor> {
  const bytes = decodeBase64Asset(content);
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
  return collaborationAssetDescriptorSchema.parse(response.data);
}

export async function downloadCollaborationAsset(roomId: string, assetId: string): Promise<string> {
  const response = await apiClient.get<ArrayBuffer>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}/assets/${encodeURIComponent(assetId)}`,
    { responseType: "arraybuffer" },
  );
  const bytes = new Uint8Array(response.data);
  if ((await sha256Hex(bytes)) !== assetId) {
    throw new Error("The downloaded collaboration asset failed its integrity check.");
  }
  return encodeBase64Asset(bytes);
}
