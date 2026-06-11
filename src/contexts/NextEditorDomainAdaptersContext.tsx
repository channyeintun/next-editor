import { createContext, useContext, useState, type PropsWithChildren } from "react";
import type { PreviewState, Slide, SlidePreviewState } from "../types/slides";
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
  setSnapshotGetter: (getter: () => PreviewState | null) => void;
  setSnapshotApplier: (applier: (previewState: PreviewState) => void) => void;
}

export interface RuntimePanelDomainAdapter {
  getSnapshot: () => RuntimePanelRecordingState | null;
  applySnapshot: (snapshot: RuntimeRecordingSnapshot) => void;
  setSnapshotGetter: (getter: () => RuntimePanelRecordingState | null) => void;
  setSnapshotApplier: (applier: (snapshot: RuntimeRecordingSnapshot) => void) => void;
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

  return {
    getSnapshot: () => getSnapshot(),
    applySnapshot: (previewState) => applySnapshot(previewState),
    setSnapshotGetter: (getter) => {
      getSnapshot = getter;
    },
    setSnapshotApplier: (applier) => {
      applySnapshot = applier;
    },
  };
}

function createRuntimePanelDomainAdapter(): RuntimePanelDomainAdapter {
  let getSnapshot: () => RuntimePanelRecordingState | null = () => null;
  let applySnapshot: (snapshot: RuntimeRecordingSnapshot) => void = () => undefined;

  return {
    getSnapshot: () => getSnapshot(),
    applySnapshot: (snapshot) => applySnapshot(snapshot),
    setSnapshotGetter: (getter) => {
      getSnapshot = getter;
    },
    setSnapshotApplier: (applier) => {
      applySnapshot = applier;
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
