import type { PreviewDomPatchBatch, PreviewInitialDocument, PreviewState } from "../types/slides";
import type { PreviewScreenshotResult } from "../utils/iframeScreenshotBridge";
import type {
  StudioPreviewCommand,
  StudioPreviewCommandResult,
} from "../utils/iframeStudioCommandBridge";

export interface LivePreviewInspection {
  capturedAt: number;
  height: number;
  html: string;
  route: string;
  url: string | null;
  width: number;
}

export interface PreviewPatchReplayInput {
  recordingId: string;
  currentTime: number;
  isSeeking: boolean;
  initialDocuments: PreviewInitialDocument[];
  patchBatches: PreviewDomPatchBatch[];
  lastAppliedPatchBatchIndex: number;
}

export type SnapshotGetter = () => PreviewState | null;
export type SnapshotApplier = (previewState: PreviewState) => void;
export type PatchReplayApplier = (input: PreviewPatchReplayInput) => number;
export type DockWidthDeltaApplier = (delta: number) => void;
export type LivePreviewInspectionGetter = () => Promise<LivePreviewInspection | null>;
export type PreviewScreenshotCapturer = () => Promise<PreviewScreenshotResult>;
export type RecordingStopPreparer = () => Promise<void>;
export type PreviewCommandExecutor = (
  command: StudioPreviewCommand,
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<StudioPreviewCommandResult>;

export interface PreviewAdapterHandle {
  snapshotGetter: { current: SnapshotGetter | null };
  snapshotApplier: { current: SnapshotApplier | null };
  patchReplayApplier: { current: PatchReplayApplier | null };
  dockWidthDeltaApplier: { current: DockWidthDeltaApplier | null };
  livePreviewInspectionGetter: { current: LivePreviewInspectionGetter | null };
  previewScreenshotCapturer: { current: PreviewScreenshotCapturer | null };
  previewCommandExecutor: { current: PreviewCommandExecutor | null };
  recordingStopPreparer: { current: RecordingStopPreparer | null };
}

export function createPreviewAdapterHandle(): PreviewAdapterHandle {
  return {
    snapshotGetter: { current: null },
    snapshotApplier: { current: null },
    patchReplayApplier: { current: null },
    dockWidthDeltaApplier: { current: null },
    livePreviewInspectionGetter: { current: null },
    previewScreenshotCapturer: { current: null },
    previewCommandExecutor: { current: null },
    recordingStopPreparer: { current: null },
  };
}
