import { applyUpdate, encodeStateAsUpdate, type Doc } from "yjs";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  collaborationCreateRoomInputSchema,
  collaborationTeachingInitializationInputSchema,
  encodedYjsSnapshotSchema,
  encodedYjsUpdateSchema,
  type CollaborationCreateRoomInput,
  type CollaborationTeachingInitializationInput,
} from "./protocol";
import { base64ToBytes, bytesToBase64 } from "./base64";

export function encodeYjsUpdate(update: Uint8Array): string {
  return encodedYjsUpdateSchema.parse(bytesToBase64(update));
}

export function decodeYjsUpdate(encoded: string): Uint8Array {
  return base64ToBytes(encodedYjsUpdateSchema.parse(encoded));
}

export function decodeYjsSnapshot(encoded: string): Uint8Array {
  return base64ToBytes(encodedYjsSnapshotSchema.parse(encoded));
}

export function encodeYjsSnapshotUpdate(update: Uint8Array): string {
  return encodedYjsSnapshotSchema.parse(bytesToBase64(update));
}

export function encodeYjsDocument(doc: Doc): string {
  return encodeYjsSnapshotUpdate(encodeStateAsUpdate(doc));
}

export function applyEncodedYjsUpdate(doc: Doc, encoded: string, origin?: unknown): void {
  applyUpdate(doc, decodeYjsUpdate(encoded), origin);
}

export function applyEncodedYjsSnapshot(doc: Doc, encoded: string, origin?: unknown): void {
  applyUpdate(doc, decodeYjsSnapshot(encoded), origin);
}

export function createCollaborationRoomSnapshot(
  doc: Doc,
  clientId: string,
  updateId: string = crypto.randomUUID(),
): CollaborationCreateRoomInput {
  return collaborationCreateRoomInputSchema.parse({
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
    clientId,
    updateId,
    snapshot: encodeYjsDocument(doc),
  });
}

export function createCollaborationTeachingInitialization(
  update: Uint8Array,
  clientId: string,
  updateId: string = crypto.randomUUID(),
): CollaborationTeachingInitializationInput {
  return collaborationTeachingInitializationInputSchema.parse({
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
    clientId,
    updateId,
    update: encodeYjsSnapshotUpdate(update),
  });
}
