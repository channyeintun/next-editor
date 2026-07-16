import type {
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
import { apiClient } from "../apiClient";

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
