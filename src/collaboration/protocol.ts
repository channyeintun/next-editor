import { z } from "zod";

export const COLLABORATION_PROTOCOL_VERSION = 2 as const;
export const COLLABORATION_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const COLLABORATION_SQLITE_PERSISTENCE_VERSION = 2 as const;
export const COLLABORATION_AWARENESS_TTL_MS = 30_000;

// Keep the first transport limit deliberately below provider/request limits. The
// client will batch small Yjs updates, while large initial states need a separate
// snapshot path before the feature is opened to large projects.
export const MAX_YJS_UPDATE_BYTES = 64 * 1024;
export const MAX_ENCODED_YJS_UPDATE_LENGTH = 4 * Math.ceil(MAX_YJS_UPDATE_BYTES / 3);
export const MAX_YJS_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_ENCODED_YJS_SNAPSHOT_LENGTH = 4 * Math.ceil(MAX_YJS_SNAPSHOT_BYTES / 3);
export const MAX_COLLABORATION_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_COLLABORATION_ROOM_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_COLLABORATION_ROOM_ASSETS = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const collaborationIdSchema = z.string().regex(UUID_PATTERN, "expected a UUID");
export const collaborationRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const collaborationInviteRoleSchema = z.enum(["editor", "viewer"]);
export const collaborationRoomStatusSchema = z.enum(["provisioning", "active", "closed", "failed"]);
export const collaborationAssetIdSchema = z
  .string()
  .regex(SHA256_PATTERN, "expected a SHA-256 digest");

export type CollaborationRole = z.infer<typeof collaborationRoleSchema>;
export type CollaborationInviteRole = z.infer<typeof collaborationInviteRoleSchema>;
export type CollaborationRoomStatus = z.infer<typeof collaborationRoomStatusSchema>;

export const collaborationAssetDescriptorSchema = z
  .object({
    id: collaborationAssetIdSchema,
    mimeType: z.string().min(1).max(120),
    size: z.number().int().positive().max(MAX_COLLABORATION_ASSET_BYTES),
  })
  .strict();

export type CollaborationAssetDescriptor = z.infer<typeof collaborationAssetDescriptorSchema>;

export interface CollaborationRoomDescriptor {
  id: string;
  ownerId: string;
  hostUserId: string;
  status: CollaborationRoomStatus;
  protocolVersion: number;
  documentSchemaVersion: number;
  roleVersion: number;
  maxMembers: number;
  createdAt: number;
  updatedAt: number;
}

export interface CollaborationMember {
  userId: string;
  role: CollaborationRole;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  joinedAt: number;
  updatedAt: number;
}

export interface CollaborationInvitation {
  id: string;
  roomId: string;
  role: CollaborationInviteRole;
  maxUses: number;
  useCount: number;
  expiresAt: number;
  revokedAt: number | null;
  createdAt: number;
}

export interface CreatedCollaborationInvitation extends CollaborationInvitation {
  token: string;
}

export interface CollaborationRoomSession {
  room: CollaborationRoomDescriptor;
  membership: { role: CollaborationRole };
}

export const createCollaborationInvitationInputSchema = z
  .object({
    role: collaborationInviteRoleSchema,
    expiresInHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 7)
      .default(24),
    maxUses: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export const updateCollaborationMemberInputSchema = z
  .object({ role: collaborationInviteRoleSchema })
  .strict();

export const claimCollaborationInvitationInputSchema = z
  .object({
    token: z
      .string()
      .min(32)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

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

export const encodedYjsSnapshotSchema = z
  .string()
  .min(4)
  .max(MAX_ENCODED_YJS_SNAPSHOT_LENGTH)
  .refine((value) => value.length % 4 === 0 && BASE64_PATTERN.test(value), "invalid base64")
  .refine((value) => decodedBase64ByteLength(value) <= MAX_YJS_SNAPSHOT_BYTES, {
    message: `Yjs snapshot exceeds ${MAX_YJS_SNAPSHOT_BYTES} bytes`,
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

export const collaborationCreateRoomInputSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    documentSchemaVersion: z.literal(COLLABORATION_DOCUMENT_SCHEMA_VERSION),
    clientId: collaborationIdSchema,
    updateId: collaborationIdSchema,
    snapshot: encodedYjsSnapshotSchema,
  })
  .strict();

export type CollaborationCreateRoomInput = z.infer<typeof collaborationCreateRoomInputSchema>;

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

const encodedRelativePositionSchema = z
  .string()
  .min(4)
  .max(2048)
  .regex(BASE64_PATTERN, "invalid relative position");

export const collaborationCursorSchema = z
  .object({
    fileNodeId: collaborationIdSchema,
    anchor: encodedRelativePositionSchema,
    head: encodedRelativePositionSchema,
  })
  .strict();

export type CollaborationCursor = z.infer<typeof collaborationCursorSchema>;

const yjsRelativePositionIdSchema = z
  .object({
    client: z.number().int().nonnegative().max(0xffff_ffff),
    clock: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const yjsRelativePositionSchema = z
  .object({
    type: yjsRelativePositionIdSchema.nullable(),
    tname: z.string().max(1024).nullable(),
    item: yjsRelativePositionIdSchema.nullable(),
    assoc: z.number().int().min(-1).max(1),
  })
  .strict();

const collaborationAwarenessSelectionSchema = z
  .object({
    anchor: yjsRelativePositionSchema,
    head: yjsRelativePositionSchema,
  })
  .strict();

const collaborationAwarenessStateFields = {
  sessionId: collaborationIdSchema,
  revision: z.number().int().nonnegative(),
  activeFileNodeId: collaborationIdSchema.nullable(),
  cursor: collaborationCursorSchema.nullable(),
  followingHost: z.boolean(),
} as const;

export const collaborationAwarenessInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("state"),
      ...collaborationAwarenessStateFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal("leave"),
      sessionId: collaborationIdSchema,
      revision: z.number().int().nonnegative(),
    })
    .strict(),
]);

export const collaborationAwarenessEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("state"),
      ...collaborationAwarenessStateFields,
      roomId: collaborationIdSchema,
      actorId: collaborationIdSchema,
      role: collaborationRoleSchema,
      username: z.string().min(1).max(64),
      name: z.string().max(120).nullable(),
      avatarUrl: z.string().max(2048).nullable(),
      isHost: z.boolean(),
      occurredAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("leave"),
      sessionId: collaborationIdSchema,
      revision: z.number().int().nonnegative(),
      roomId: collaborationIdSchema,
      actorId: collaborationIdSchema,
      occurredAt: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type CollaborationAwarenessInput = z.infer<typeof collaborationAwarenessInputSchema>;
export type CollaborationAwarenessEvent = z.infer<typeof collaborationAwarenessEventSchema>;

export const collaborationAwarenessClientStateSchema = z
  .object({
    collaboration: collaborationAwarenessInputSchema,
    selection: collaborationAwarenessSelectionSchema.nullable().optional(),
  })
  .strict();

export const collaborationAwarenessServerStateSchema = z
  .object({
    collaboration: collaborationAwarenessEventSchema,
    selection: collaborationAwarenessSelectionSchema.nullable().optional(),
  })
  .strict();

export const collaborationControlEventSchema = z
  .object({
    kind: z.enum(["membership-changed", "room-closed"]),
    roomId: collaborationIdSchema,
    roleVersion: z.number().int().positive(),
    targetUserId: collaborationIdSchema.nullable(),
    occurredAt: z.number().int().nonnegative(),
  })
  .strict();

export type CollaborationControlEvent = z.infer<typeof collaborationControlEventSchema>;

export interface CollaborationUpdateAccepted {
  accepted: true;
  updateId: string;
  streamId?: string;
}

export interface CollaborationDocumentSnapshot {
  generation: number;
  streamCutoff: string;
  update: string;
}

export interface CollaborationBootstrapResponse {
  protocolVersion: number;
  documentSchemaVersion: number;
  snapshot: CollaborationDocumentSnapshot;
  updates: Array<{ streamId: string; event: CollaborationDocumentUpdateEvent }>;
  nextCursor: string;
  hasMore: boolean;
}

export const collaborationWebSocketServerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("session.ready"),
      sessionId: collaborationIdSchema,
      attemptId: collaborationIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("document.ack"),
      updateId: collaborationIdSchema,
      streamId: z.string().regex(/^\d+-\d+$/),
      duplicate: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("control.room"),
      data: collaborationControlEventSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.string().min(1).max(64),
      message: z.string().min(1).max(512),
      fatal: z.boolean(),
      updateId: collaborationIdSchema.optional(),
    })
    .strict(),
]);

export const collaborationRoomControlCommandSchema = z
  .object({
    event: collaborationControlEventSchema,
    targetRole: collaborationRoleSchema.nullable().optional(),
  })
  .strict();

export type CollaborationWebSocketServerMessage = z.infer<
  typeof collaborationWebSocketServerMessageSchema
>;
export type CollaborationRoomControlCommand = z.infer<typeof collaborationRoomControlCommandSchema>;

export function canPublishCollaborationUpdate(role: CollaborationRole): boolean {
  return role === "owner" || role === "editor";
}
