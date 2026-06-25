import { createContext, useContext, useState, type PropsWithChildren } from "react";
import type {
  PreviewDomPatchBatch,
  PreviewInitialDocument,
  PreviewState,
  Slide,
  SlidePreviewState,
} from "../types/slides";
import type { RuntimePanelRecordingState, RuntimeRecordingSnapshot } from "../types/runtime";

export interface SlideStateSnapshot {
  previewState: SlidePreviewState;
  currentSlideIndex: number;
}

export interface SlidesDomainAdapter {
  getSnapshot: () => SlideStateSnapshot | null;
  applySnapshot: (slideState: SlidePreviewState, currentSlideIndex: number) => void;
  getSlides: () => Slide[];
  applySlides: (slides: Slide[]) => void;
  navigate: (indexh: number, indexv: number) => void;
  setSnapshotGetter: (getter: () => SlideStateSnapshot | null) => void;
  setSnapshotApplier: (
    applier: (slideState: SlidePreviewState, currentSlideIndex: number) => void,
  ) => void;
  setSlidesGetter: (getter: () => Slide[]) => void;
  setSlidesApplier: (applier: (slides: Slide[]) => void) => void;
  setNavigator: (navigator: (indexh: number, indexv: number) => void) => void;
}

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

export interface RuntimePanelDomainAdapter {
  appendConsoleLine: (line: string) => void;
  getSnapshot: () => RuntimePanelRecordingState | null;
  applySnapshot: (snapshot: RuntimeRecordingSnapshot) => void;
  openConsole: () => void;
  setConsoleAppender: (appender: (line: string) => void) => void;
  setSnapshotGetter: (getter: () => RuntimePanelRecordingState | null) => void;
  setSnapshotApplier: (applier: (snapshot: RuntimeRecordingSnapshot) => void) => void;
  setConsoleOpener: (opener: () => void) => void;
}

export interface NextEditorDomainAdapters {
  slides: SlidesDomainAdapter;
  preview: PreviewDomainAdapter;
  runtimePanel: RuntimePanelDomainAdapter;
}

function createSlidesDomainAdapter(): SlidesDomainAdapter {
  let getSnapshot: () => SlideStateSnapshot | null = () => null;
  let applySnapshot: (slideState: SlidePreviewState, currentSlideIndex: number) => void = () =>
    undefined;
  let getSlides: () => Slide[] = () => [];
  let applySlides: (slides: Slide[]) => void = () => undefined;
  let navigate: (indexh: number, indexv: number) => void = () => undefined;

  return {
    getSnapshot: () => getSnapshot(),
    applySnapshot: (slideState, currentSlideIndex) => applySnapshot(slideState, currentSlideIndex),
    getSlides: () => getSlides(),
    applySlides: (slides) => applySlides(slides),
    navigate: (indexh, indexv) => navigate(indexh, indexv),
    setSnapshotGetter: (getter) => {
      getSnapshot = getter;
    },
    setSnapshotApplier: (applier) => {
      applySnapshot = applier;
    },
    setSlidesGetter: (getter) => {
      getSlides = getter;
    },
    setSlidesApplier: (applier) => {
      applySlides = applier;
    },
    setNavigator: (nextNavigator) => {
      navigate = nextNavigator;
    },
  };
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

function createRuntimePanelDomainAdapter(): RuntimePanelDomainAdapter {
  let getSnapshot: () => RuntimePanelRecordingState | null = () => null;
  let applySnapshot: (snapshot: RuntimeRecordingSnapshot) => void = () => undefined;
  let openConsole: () => void = () => undefined;
  let appendConsoleLine: (line: string) => void = () => undefined;

  return {
    appendConsoleLine: (line) => appendConsoleLine(line),
    getSnapshot: () => getSnapshot(),
    applySnapshot: (snapshot) => applySnapshot(snapshot),
    openConsole: () => openConsole(),
    setConsoleAppender: (appender) => {
      appendConsoleLine = appender;
    },
    setSnapshotGetter: (getter) => {
      getSnapshot = getter;
    },
    setSnapshotApplier: (applier) => {
      applySnapshot = applier;
    },
    setConsoleOpener: (opener) => {
      openConsole = opener;
    },
  };
}

const NextEditorDomainAdaptersContext = createContext<NextEditorDomainAdapters | null>(null);

export function NextEditorDomainAdaptersProvider({ children }: PropsWithChildren) {
  const [adapters] = useState<NextEditorDomainAdapters>(() => ({
    slides: createSlidesDomainAdapter(),
    preview: createPreviewDomainAdapter(),
    runtimePanel: createRuntimePanelDomainAdapter(),
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
