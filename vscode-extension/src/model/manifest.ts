import type { DocumentDescriptor, TabDescriptor, WorkspaceRootDescriptor } from "./events";

// Manifest version 1 (plan §7.3). No absolute source paths, ever.
export type ManifestV1 = {
  kind: "next-recording";
  formatVersion: 1;
  sessionId: string;
  createdAt: string;
  finalizedAt: string;
  durationUs: number;
  producer: {
    extensionVersion: string;
    vscodeVersion: string;
    platform: string;
    architecture: string;
  };
  timebase: { kind: "host-monotonic-us" };
  capabilities: {
    textDocuments: boolean;
    selections: boolean;
    verticalViewport: boolean;
    topology: boolean;
    audio: boolean;
    unsupportedSurfaceMarkers: boolean;
  };
  limitsApplied: string[];
  workspaceRoots: WorkspaceRootDescriptor[];
  documents: DocumentDescriptor[];
  tabs: TabDescriptor[];
  initialTopologyRef: { eventSeq: number } | null;
  eventJournalRef: { entry: string; eventCount: number };
  seekIndexRef: { entry: string };
  audioTracks: AudioTrackMetadata[];
  integrity: {
    /** SHA-256 per archive entry (entry name -> hex digest). */
    entries: Record<string, string>;
  };
};

export type AudioTrackMetadata = {
  audioTrackId: string;
  entry: string;
  codec: "pcm-wav";
  sampleRate: number;
  channels: number;
  startTUs: number;
  calibration: {
    coefficients: { offsetUs: number; drift: number };
    points: number;
    uncertaintyUs: { p50: number; p95: number };
  } | null;
};

export const ARCHIVE_ENTRIES = {
  manifest: "manifest.json",
  events: "events.ndjson",
  index: "index.json",
  checkpointDir: (documentId: string) => `documents/${documentId}/checkpoints`,
  checkpoint: (documentId: string, checkpointId: string) =>
    `documents/${documentId}/checkpoints/${checkpointId}.txt`,
  audio: (audioTrackId: string) => `audio/${audioTrackId}.wav`,
  integrity: "integrity.json",
} as const;
