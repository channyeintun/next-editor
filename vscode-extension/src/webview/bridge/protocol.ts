import { z } from "zod";
import { sessionEventSchema } from "../../model/schemas";

// Versioned, discriminated host<->webview protocol (plan §10.2). Both
// sides validate every message; unknown types are ignored, never executed.
export const PROTOCOL_VERSION = 2;

const requestId = z.string().min(1).max(128);

const documentSummary = z.object({
  documentId: z.string(),
  displayName: z.string(),
  logicalPath: z.string(),
  languageId: z.string(),
});

export const recordingMetadataSchema = z.object({
  fileName: z.string(),
  sessionId: z.string(),
  durationUs: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  hasAudio: z.boolean(),
  defaultSpeed: z.number().positive(),
  documents: z.array(documentSummary),
  workspaceRoots: z.array(z.object({ rootId: z.string(), name: z.string() })),
});
export type RecordingMetadataPayload = z.infer<typeof recordingMetadataSchema>;

export const hostToWebviewSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("host.hello"),
    protocolVersion: z.number().int(),
  }),
  z.object({
    type: z.literal("recording.metadata"),
    payload: recordingMetadataSchema,
  }),
  z.object({
    type: z.literal("recording.eventWindow"),
    requestId,
    fromSeq: z.number().int().nonnegative(),
    events: z.array(sessionEventSchema),
    done: z.boolean(),
  }),
  z.object({
    type: z.literal("recording.checkpoint"),
    requestId,
    documentId: z.string(),
    checkpointId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("request.failed"),
    requestId,
    message: z.string(),
  }),
  z.object({ type: z.literal("player.pause") }),
]);
export type HostToWebviewMessage = z.infer<typeof hostToWebviewSchema>;

export const webviewToHostSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("webview.ready"),
    protocolVersion: z.number().int(),
  }),
  z.object({
    type: z.literal("recording.requestWindow"),
    requestId,
    fromSeq: z.number().int().nonnegative(),
    maxCount: z.number().int().positive().max(50_000),
  }),
  z.object({
    type: z.literal("recording.requestCheckpoint"),
    requestId,
    documentId: z.string(),
    checkpointId: z.string(),
  }),
  z.object({
    type: z.literal("player.stateChanged"),
    playheadUs: z.number().nonnegative(),
    rate: z.number().positive(),
    playing: z.boolean(),
  }),
  z.object({ type: z.literal("webview.error"), message: z.string().max(4000) }),
]);
export type WebviewToHostMessage = z.infer<typeof webviewToHostSchema>;

export function parseHostMessage(raw: unknown): HostToWebviewMessage | null {
  const result = hostToWebviewSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function parseWebviewMessage(raw: unknown): WebviewToHostMessage | null {
  const result = webviewToHostSchema.safeParse(raw);
  return result.success ? result.data : null;
}
