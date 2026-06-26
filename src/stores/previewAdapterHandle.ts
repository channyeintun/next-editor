import type { PreviewDomPatchBatch, PreviewInitialDocument, PreviewState } from "../types/slides";

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

export interface PreviewAdapterHandle {
  snapshotGetter: { current: SnapshotGetter | null };
  snapshotApplier: { current: SnapshotApplier | null };
  patchReplayApplier: { current: PatchReplayApplier | null };
  dockWidthDeltaApplier: { current: DockWidthDeltaApplier | null };
}

export function createPreviewAdapterHandle(): PreviewAdapterHandle {
  return {
    snapshotGetter: { current: null },
    snapshotApplier: { current: null },
    patchReplayApplier: { current: null },
    dockWidthDeltaApplier: { current: null },
  };
}
