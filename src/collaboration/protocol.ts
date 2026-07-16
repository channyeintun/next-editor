import { z } from "zod";

export const COLLABORATION_PROTOCOL_VERSION = 1 as const;
export const COLLABORATION_DOCUMENT_SCHEMA_VERSION = 1 as const;

// Keep the first transport limit deliberately below provider/request limits. The
// client will batch small Yjs updates, while large initial states need a separate
// snapshot path before the feature is opened to large projects.
export const MAX_YJS_UPDATE_BYTES = 64 * 1024;
export const MAX_ENCODED_YJS_UPDATE_LENGTH = 4 * Math.ceil(MAX_YJS_UPDATE_BYTES / 3);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const collaborationIdSchema = z.string().regex(UUID_PATTERN, "expected a UUID");
export const collaborationRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const collaborationRoomStatusSchema = z.enum(["provisioning", "active", "closed", "failed"]);

export type CollaborationRole = z.infer<typeof collaborationRoleSchema>;
export type CollaborationRoomStatus = z.infer<typeof collaborationRoomStatusSchema>;

export interface CollaborationRoomDescriptor {
  id: string;
  ownerId: string;
  hostUserId: string;
  status: CollaborationRoomStatus;
  protocolVersion: number;
  documentSchemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface CollaborationRoomSession {
  room: CollaborationRoomDescriptor;
  membership: { role: CollaborationRole };
  channel: string;
}

function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export const encodedYjsUpdateSchema = z
  .string()
  .min(4)
  .max(MAX_ENCODED_YJS_UPDATE_LENGTH)
  .refine((value) => value.length % 4 === 0 && BASE64_PATTERN.test(value), "invalid base64")
  .refine((value) => decodedBase64ByteLength(value) <= MAX_YJS_UPDATE_BYTES, {
    message: `Yjs update exceeds ${MAX_YJS_UPDATE_BYTES} bytes`,
  });

export const collaborationDocumentUpdateInputSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    documentSchemaVersion: z.literal(COLLABORATION_DOCUMENT_SCHEMA_VERSION),
    clientId: collaborationIdSchema,
    updateId: collaborationIdSchema,
    update: encodedYjsUpdateSchema,
  })
  .strict();

export const collaborationDocumentUpdateEventSchema = collaborationDocumentUpdateInputSchema
  .extend({
    roomId: collaborationIdSchema,
    actorId: collaborationIdSchema,
    receivedAt: z.number().int().nonnegative(),
  })
  .strict();

export type CollaborationDocumentUpdateInput = z.infer<
  typeof collaborationDocumentUpdateInputSchema
>;
export type CollaborationDocumentUpdateEvent = z.infer<
  typeof collaborationDocumentUpdateEventSchema
>;

export interface CollaborationUpdateAccepted {
  accepted: true;
  updateId: string;
}

export const collaborationRealtimeSchema = {
  document: {
    update: collaborationDocumentUpdateEventSchema,
  },
} as const;

export type CollaborationRealtimeEvents = typeof collaborationRealtimeSchema;

const ROOM_CHANNEL_PREFIX = "collab:room:";

export function collaborationRoomChannel(roomId: string): string {
  return `${ROOM_CHANNEL_PREFIX}${collaborationIdSchema.parse(roomId)}`;
}

export function roomIdFromCollaborationChannel(channel: string): string | null {
  if (!channel.startsWith(ROOM_CHANNEL_PREFIX)) return null;
  const result = collaborationIdSchema.safeParse(channel.slice(ROOM_CHANNEL_PREFIX.length));
  return result.success ? result.data : null;
}

export function canPublishCollaborationUpdate(role: CollaborationRole): boolean {
  return role === "owner" || role === "editor";
}
