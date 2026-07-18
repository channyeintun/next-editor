import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { collaborationIdSchema } from "./protocol";

// The only supported room wire version carries document sync/update and
// authenticated standard-awareness frames in one binary envelope.
export const COLLABORATION_BINARY_PROTOCOL_VERSION = 3 as const;

const BINARY_FRAME_SYNC = 0;
const BINARY_FRAME_CLIENT_UPDATE = 1;
const BINARY_FRAME_SERVER_UPDATE = 2;
const BINARY_FRAME_AWARENESS = 3;
const MAX_AWARENESS_UPDATE_ENTRIES = 100;

type SyncMessageType =
  | typeof syncProtocol.messageYjsSyncStep1
  | typeof syncProtocol.messageYjsSyncStep2
  | typeof syncProtocol.messageYjsUpdate;

export type CollaborationBinaryFrame =
  | { kind: "sync"; messageType: SyncMessageType; payload: Uint8Array }
  | {
      kind: "client-update";
      clientId: string;
      updateId: string;
      update: Uint8Array;
    }
  | {
      kind: "server-update";
      streamId: string;
      updateId: string;
      update: Uint8Array;
    }
  | { kind: "awareness"; update: Uint8Array };

export interface CollaborationAwarenessProtocolEntry {
  clientId: number;
  clock: number;
  state: Record<string, unknown> | null;
}

export class CollaborationBinaryProtocolError extends Error {
  constructor(message = "invalid collaboration binary frame") {
    super(message);
    this.name = "CollaborationBinaryProtocolError";
  }
}

function createFrameEncoder(frameType: number): encoding.Encoder {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, COLLABORATION_BINARY_PROTOCOL_VERSION);
  encoding.writeVarUint(encoder, frameType);
  return encoder;
}

function finishFrame(encoder: encoding.Encoder): Uint8Array {
  return encoding.toUint8Array(encoder);
}

function parseId(value: string): string {
  const parsed = collaborationIdSchema.safeParse(value);
  if (!parsed.success) throw new CollaborationBinaryProtocolError();
  return parsed.data;
}

function parseStreamId(value: string): string {
  if (!/^\d+-\d+$/.test(value)) throw new CollaborationBinaryProtocolError();
  return value;
}

function readSyncPayload(decoder: decoding.Decoder): {
  messageType: SyncMessageType;
  payload: Uint8Array;
} {
  const messageType = decoding.readVarUint(decoder);
  if (
    messageType !== syncProtocol.messageYjsSyncStep1 &&
    messageType !== syncProtocol.messageYjsSyncStep2 &&
    messageType !== syncProtocol.messageYjsUpdate
  ) {
    throw new CollaborationBinaryProtocolError("unsupported Yjs sync message");
  }
  return { messageType, payload: decoding.readVarUint8Array(decoder) };
}

function assertFrameConsumed(decoder: decoding.Decoder): void {
  if (decoding.hasContent(decoder)) {
    throw new CollaborationBinaryProtocolError("collaboration binary frame has trailing bytes");
  }
}

function assertAwarenessInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CollaborationBinaryProtocolError("invalid awareness integer");
  }
}

function parseAwarenessState(value: string): Record<string, unknown> | null {
  const state = JSON.parse(value) as unknown;
  if (state !== null && (typeof state !== "object" || Array.isArray(state))) {
    throw new CollaborationBinaryProtocolError("invalid awareness state");
  }
  return state as Record<string, unknown> | null;
}

export function encodeCollaborationSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = createFrameEncoder(BINARY_FRAME_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return finishFrame(encoder);
}

export function encodeCollaborationSyncStep2(doc: Y.Doc, stateVector: Uint8Array): Uint8Array {
  const encoder = createFrameEncoder(BINARY_FRAME_SYNC);
  syncProtocol.writeSyncStep2(encoder, doc, stateVector);
  return finishFrame(encoder);
}

export function encodeCollaborationClientUpdate(input: {
  clientId: string;
  updateId: string;
  update: Uint8Array;
}): Uint8Array {
  const encoder = createFrameEncoder(BINARY_FRAME_CLIENT_UPDATE);
  encoding.writeVarString(encoder, collaborationIdSchema.parse(input.clientId));
  encoding.writeVarString(encoder, collaborationIdSchema.parse(input.updateId));
  syncProtocol.writeUpdate(encoder, input.update);
  return finishFrame(encoder);
}

export function encodeCollaborationServerUpdate(input: {
  streamId: string;
  updateId: string;
  update: Uint8Array;
}): Uint8Array {
  const encoder = createFrameEncoder(BINARY_FRAME_SERVER_UPDATE);
  if (!/^\d+-\d+$/.test(input.streamId)) {
    throw new CollaborationBinaryProtocolError("invalid collaboration stream ID");
  }
  encoding.writeVarString(encoder, input.streamId);
  encoding.writeVarString(encoder, collaborationIdSchema.parse(input.updateId));
  syncProtocol.writeUpdate(encoder, input.update);
  return finishFrame(encoder);
}

export function encodeCollaborationAwarenessUpdate(update: Uint8Array): Uint8Array {
  const encoder = createFrameEncoder(BINARY_FRAME_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return finishFrame(encoder);
}

export function encodeCollaborationAwarenessProtocolUpdate(
  entries: readonly CollaborationAwarenessProtocolEntry[],
): Uint8Array {
  if (entries.length > MAX_AWARENESS_UPDATE_ENTRIES) {
    throw new CollaborationBinaryProtocolError("too many awareness entries");
  }
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    assertAwarenessInteger(entry.clientId);
    assertAwarenessInteger(entry.clock);
    const state = JSON.stringify(entry.state);
    if (state === undefined) throw new CollaborationBinaryProtocolError("invalid awareness state");
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, state);
  }
  return encoding.toUint8Array(encoder);
}

export function decodeCollaborationAwarenessProtocolUpdate(
  update: Uint8Array,
): CollaborationAwarenessProtocolEntry[] {
  try {
    const decoder = decoding.createDecoder(update);
    const length = decoding.readVarUint(decoder);
    if (length > MAX_AWARENESS_UPDATE_ENTRIES) {
      throw new CollaborationBinaryProtocolError("too many awareness entries");
    }
    const entries: CollaborationAwarenessProtocolEntry[] = [];
    for (let index = 0; index < length; index += 1) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      assertAwarenessInteger(clientId);
      assertAwarenessInteger(clock);
      entries.push({
        clientId,
        clock,
        state: parseAwarenessState(decoding.readVarString(decoder)),
      });
    }
    assertFrameConsumed(decoder);
    return entries;
  } catch (error) {
    if (error instanceof CollaborationBinaryProtocolError) throw error;
    throw new CollaborationBinaryProtocolError("invalid awareness update");
  }
}

export function decodeCollaborationBinaryFrame(
  input: ArrayBuffer | Uint8Array,
): CollaborationBinaryFrame {
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const decoder = decoding.createDecoder(bytes);
    const version = decoding.readVarUint(decoder);
    if (version !== COLLABORATION_BINARY_PROTOCOL_VERSION) {
      throw new CollaborationBinaryProtocolError("unsupported collaboration binary protocol");
    }
    const frameType = decoding.readVarUint(decoder);
    if (frameType === BINARY_FRAME_SYNC) {
      const frame = readSyncPayload(decoder);
      assertFrameConsumed(decoder);
      return { kind: "sync", ...frame };
    }
    if (frameType === BINARY_FRAME_CLIENT_UPDATE) {
      const clientId = parseId(decoding.readVarString(decoder));
      const updateId = parseId(decoding.readVarString(decoder));
      const sync = readSyncPayload(decoder);
      if (sync.messageType !== syncProtocol.messageYjsUpdate) {
        throw new CollaborationBinaryProtocolError("client frame is not a Yjs update");
      }
      assertFrameConsumed(decoder);
      return { kind: "client-update", clientId, updateId, update: sync.payload };
    }
    if (frameType === BINARY_FRAME_SERVER_UPDATE) {
      const streamId = parseStreamId(decoding.readVarString(decoder));
      const updateId = parseId(decoding.readVarString(decoder));
      const sync = readSyncPayload(decoder);
      if (sync.messageType !== syncProtocol.messageYjsUpdate) {
        throw new CollaborationBinaryProtocolError("server frame is not a Yjs update");
      }
      assertFrameConsumed(decoder);
      return { kind: "server-update", streamId, updateId, update: sync.payload };
    }
    if (frameType === BINARY_FRAME_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      assertFrameConsumed(decoder);
      return { kind: "awareness", update };
    }
    throw new CollaborationBinaryProtocolError("unknown collaboration binary frame");
  } catch (error) {
    if (error instanceof CollaborationBinaryProtocolError) throw error;
    throw new CollaborationBinaryProtocolError();
  }
}
