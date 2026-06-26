import { createContext, useContext, useState, type PropsWithChildren } from "react";
import type { PreviewDomPatchBatch, PreviewInitialDocument, PreviewState } from "../types/slides";

export interface PreviewDomainAdapter {
  getSnapshot: () => PreviewState | null;
  applySnapshot: (previewState: PreviewState) => void;
  applyPatchReplay: (input: PreviewPatchReplayInput) => number;
  /** Apply a docked-preview width offset (px) to the viewer's current dock width during replay. */
  applyDockWidthDelta: (delta: number) => void;
  setSnapshotGetter: (getter: () => PreviewState | null) => void;
  setSnapshotApplier: (applier: (previewState: PreviewState) => void) => void;
  setPatchReplayApplier: (applier: (input: PreviewPatchReplayInput) => number) => void;
  setDockWidthDeltaApplier: (applier: (delta: number) => void) => void;
}

export interface PreviewPatchReplayInput {
  recordingId: string;
  currentTime: number;
  isSeeking: boolean;
  initialDocuments: PreviewInitialDocument[];
  patchBatches: PreviewDomPatchBatch[];
  lastAppliedPatchBatchIndex: number;
}

export interface NextEditorDomainAdapters {
  preview: PreviewDomainAdapter;
}

function createPreviewDomainAdapter(): PreviewDomainAdapter {
  let getSnapshot: () => PreviewState | null = () => null;
  let applySnapshot: (previewState: PreviewState) => void = () => undefined;
  let applyPatchReplay: (input: PreviewPatchReplayInput) => number = (input) =>
    input.lastAppliedPatchBatchIndex;
  let applyDockWidthDelta: (delta: number) => void = () => undefined;

  return {
    getSnapshot: () => getSnapshot(),
    applySnapshot: (previewState) => applySnapshot(previewState),
    applyPatchReplay: (input) => applyPatchReplay(input),
    applyDockWidthDelta: (delta) => applyDockWidthDelta(delta),
    setSnapshotGetter: (getter) => {
      getSnapshot = getter;
    },
    setSnapshotApplier: (applier) => {
      applySnapshot = applier;
    },
    setPatchReplayApplier: (applier) => {
      applyPatchReplay = applier;
    },
    setDockWidthDeltaApplier: (applier) => {
      applyDockWidthDelta = applier;
    },
  };
}

const NextEditorDomainAdaptersContext = createContext<NextEditorDomainAdapters | null>(null);

export function NextEditorDomainAdaptersProvider({ children }: PropsWithChildren) {
  const [adapters] = useState<NextEditorDomainAdapters>(() => ({
    preview: createPreviewDomainAdapter(),
  }));

  return (
    <NextEditorDomainAdaptersContext value={adapters}>{children}</NextEditorDomainAdaptersContext>
  );
}

export function useNextEditorDomainAdapters(): NextEditorDomainAdapters {
  const context = useContext(NextEditorDomainAdaptersContext);

  if (!context) {
    throw new Error(
      "useNextEditorDomainAdapters must be used within a NextEditorDomainAdaptersProvider",
    );
  }

  return context;
}
