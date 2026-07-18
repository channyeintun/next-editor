import { applyUpdate, encodeStateAsUpdate, type Doc } from "yjs";
import {
  COLLABORATION_DOCUMENT_SCHEMA_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  collaborationDocumentUpdateInputSchema,
  collaborationCreateRoomInputSchema,
  collaborationTeachingInitializationInputSchema,
  encodedYjsSnapshotSchema,
  encodedYjsUpdateSchema,
  type CollaborationDocumentUpdateInput,
  type CollaborationCreateRoomInput,
  type CollaborationTeachingInitializationInput,
} from "./protocol";

const BINARY_CHUNK_SIZE = 0x8000;

export function encodeYjsUpdate(update: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < update.length; offset += BINARY_CHUNK_SIZE) {
    binary += String.fromCharCode(...update.subarray(offset, offset + BINARY_CHUNK_SIZE));
  }
  return encodedYjsUpdateSchema.parse(btoa(binary));
}

export function decodeYjsUpdate(encoded: string): Uint8Array {
  const binary = atob(encodedYjsUpdateSchema.parse(encoded));
  const update = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    update[index] = binary.charCodeAt(index);
  }
  return update;
}

export function decodeYjsSnapshot(encoded: string): Uint8Array {
  const binary = atob(encodedYjsSnapshotSchema.parse(encoded));
  const update = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    update[index] = binary.charCodeAt(index);
  }
  return update;
}

export function encodeYjsDocument(doc: Doc): string {
  const update = encodeStateAsUpdate(doc);
  let binary = "";
  for (let offset = 0; offset < update.length; offset += BINARY_CHUNK_SIZE) {
    binary += String.fromCharCode(...update.subarray(offset, offset + BINARY_CHUNK_SIZE));
  }
  return encodedYjsSnapshotSchema.parse(btoa(binary));
}

export function encodeYjsSnapshotUpdate(update: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < update.length; offset += BINARY_CHUNK_SIZE) {
    binary += String.fromCharCode(...update.subarray(offset, offset + BINARY_CHUNK_SIZE));
  }
  return encodedYjsSnapshotSchema.parse(btoa(binary));
}

export function applyEncodedYjsUpdate(doc: Doc, encoded: string, origin?: unknown): void {
  applyUpdate(doc, decodeYjsUpdate(encoded), origin);
}

export function applyEncodedYjsSnapshot(doc: Doc, encoded: string, origin?: unknown): void {
  applyUpdate(doc, decodeYjsSnapshot(encoded), origin);
}

export function createCollaborationDocumentUpdate(
  update: Uint8Array,
  clientId: string,
  updateId: string = crypto.randomUUID(),
): CollaborationDocumentUpdateInput {
  return collaborationDocumentUpdateInputSchema.parse({
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    documentSchemaVersion: COLLABORATION_DOCUMENT_SCHEMA_VERSION,
    clientId,
    updateId,
    update: encodeYjsUpdate(update),
  });
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
