// Works in the Node extension host (>=18) and in the webview without
// importing node:crypto, so this module stays environment-neutral.
declare const crypto: { randomUUID(): string };
const randomUUID = (): string => crypto.randomUUID();

// Centralized branding/identifiers (plan §6.3). Changing the product name
// must not require touching the format engine.
export const EXTENSION_ID = "channyeintun.next-recording";
export const COMMAND_NAMESPACE = "nextRecording";
export const CONFIG_NAMESPACE = "nextRecording";
export const PLAYER_VIEW_TYPE = "nextRecording.player";
export const ARTIFACT_EXTENSION = ".nextrecording";

export const COMMANDS = {
  start: `${COMMAND_NAMESPACE}.start`,
  stop: `${COMMAND_NAMESPACE}.stop`,
  recover: `${COMMAND_NAMESPACE}.recover`,
  open: `${COMMAND_NAMESPACE}.open`,
  export: `${COMMAND_NAMESPACE}.export`,
} as const;

export const CONTEXT_KEYS = {
  isPreparing: `${COMMAND_NAMESPACE}.isPreparing`,
  isRecording: `${COMMAND_NAMESPACE}.isRecording`,
  isStopping: `${COMMAND_NAMESPACE}.isStopping`,
  hasRecoverableSession: `${COMMAND_NAMESPACE}.hasRecoverableSession`,
  audioAvailable: `${COMMAND_NAMESPACE}.audioAvailable`,
  playerActive: `${COMMAND_NAMESPACE}.playerActive`,
} as const;

// Session-local opaque identifiers (plan §7.1). Never derived from API
// object identity or filesystem paths.
export type SessionId = string & { readonly __brand: "SessionId" };
export type RootId = string & { readonly __brand: "RootId" };
export type DocumentId = string & { readonly __brand: "DocumentId" };
export type SurfaceId = string & { readonly __brand: "SurfaceId" };
export type TabId = string & { readonly __brand: "TabId" };
export type GroupId = string & { readonly __brand: "GroupId" };
export type CheckpointId = string & { readonly __brand: "CheckpointId" };
export type AudioTrackId = string & { readonly __brand: "AudioTrackId" };

export const newSessionId = (): SessionId => randomUUID() as SessionId;
export const newRootId = (): RootId => randomUUID() as RootId;
export const newDocumentId = (): DocumentId => randomUUID() as DocumentId;
export const newSurfaceId = (): SurfaceId => randomUUID() as SurfaceId;
export const newTabId = (): TabId => randomUUID() as TabId;
export const newGroupId = (): GroupId => randomUUID() as GroupId;
export const newCheckpointId = (): CheckpointId => randomUUID() as CheckpointId;
export const newAudioTrackId = (): AudioTrackId => randomUUID() as AudioTrackId;
