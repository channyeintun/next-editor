import type {
  CollaborationDocumentUpdateInput,
  CollaborationRoomSession,
  CollaborationUpdateAccepted,
} from "../../../src/collaboration/protocol";
import { apiClient } from "../apiClient";

export async function createCollaborationRoom(
  initialUpdate: CollaborationDocumentUpdateInput,
): Promise<CollaborationRoomSession> {
  const response = await apiClient.post<CollaborationRoomSession>(
    "/collaboration/rooms",
    initialUpdate,
  );
  return response.data;
}

export async function getCollaborationRoom(roomId: string): Promise<CollaborationRoomSession> {
  const response = await apiClient.get<CollaborationRoomSession>(
    `/collaboration/rooms/${encodeURIComponent(roomId)}`,
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
