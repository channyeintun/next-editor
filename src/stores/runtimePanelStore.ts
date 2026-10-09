import { createStore } from "@xstate/store-react";
import type {
  RuntimeDockTab,
  RuntimePanelRecordingState,
  RuntimeRecordingSnapshot,
  RuntimeTerminalScrollLines,
} from "../types/runtime";

export interface RuntimePanelContext {
  activeTab: RuntimeDockTab;
  isCollapsed: boolean;
  isFullHeight: boolean;
  isSettingsOpen: boolean;
  consoleLines: string[];
  terminalScrollLines: RuntimeTerminalScrollLines;
  playbackSnapshot: RuntimeRecordingSnapshot | null;
  /**
   * The viewer's own full-height choice for the replayed dock, or null when they
   * have not touched the toggle. Pressing it while a replay is loaded (playing,
   * paused, ready or ended) sets this, and from then on it wins over the recording's full-height changes, across pause, resume,
   * seeking and the end of playback. It ends (back to null) when the editor leaves
   * playback: another recording is loaded, the lesson is unloaded, or a take starts
   * (see useEndViewerDockOverride in hooks/useRuntimeDockLayout.ts). It is
   * viewer-only: selectRecordingState leaves it out, so no recording or runtime
   * track ever captures it, and the live isFullHeight that record mode and the
   * studio Performer drive is left untouched.
   */
  viewerFullHeight: boolean | null;
}

export type ConsoleAppender = (message: string) => void;
export type ConsoleOpener = () => void;

const DEFAULT_CONTEXT: RuntimePanelContext = {
  activeTab: "runner",
  isCollapsed: false,
  isFullHeight: false,
  isSettingsOpen: false,
  consoleLines: [],
  terminalScrollLines: {},
  playbackSnapshot: null,
  viewerFullHeight: null,
};

export function createRuntimePanelStore() {
  return createStore({
    context: DEFAULT_CONTEXT,
    on: {
      setActiveTab: (context, event: { tab: RuntimeDockTab }) =>
        event.tab === context.activeTab ? context : { ...context, activeTab: event.tab },
      setIsCollapsed: (context, event: { collapsed: boolean }) =>
        event.collapsed === context.isCollapsed
          ? context
          : { ...context, isCollapsed: event.collapsed },
      setIsFullHeight: (context, event: { fullHeight: boolean }) =>
        event.fullHeight === context.isFullHeight
          ? context
          : { ...context, isFullHeight: event.fullHeight },
      setIsSettingsOpen: (context, event: { open: boolean }) =>
        event.open === context.isSettingsOpen
          ? context
          : { ...context, isSettingsOpen: event.open },
      setConsoleLines: (context, event: { consoleLines: string[] }) =>
        event.consoleLines === context.consoleLines
          ? context
          : { ...context, consoleLines: event.consoleLines },
      setTerminalScrollLines: (
        context,
        event: { terminalScrollLines: RuntimeTerminalScrollLines },
      ) =>
        event.terminalScrollLines === context.terminalScrollLines
          ? context
          : { ...context, terminalScrollLines: event.terminalScrollLines },
      setViewerFullHeight: (context, event: { fullHeight: boolean }) =>
        event.fullHeight === context.viewerFullHeight
          ? context
          : { ...context, viewerFullHeight: event.fullHeight },
      clearViewerFullHeight: (context) =>
        context.viewerFullHeight === null ? context : { ...context, viewerFullHeight: null },
      setPlaybackSnapshot: (context, event: { snapshot: RuntimeRecordingSnapshot | null }) =>
        event.snapshot === context.playbackSnapshot
          ? context
          : { ...context, playbackSnapshot: event.snapshot },
    },
  });
}

export type RuntimePanelStoreInstance = ReturnType<typeof createRuntimePanelStore>;

export const selectActiveTab = (context: RuntimePanelContext): RuntimeDockTab => context.activeTab;
export const selectIsCollapsed = (context: RuntimePanelContext): boolean => context.isCollapsed;
export const selectIsFullHeight = (context: RuntimePanelContext): boolean => context.isFullHeight;
export const selectViewerFullHeight = (context: RuntimePanelContext): boolean | null =>
  context.viewerFullHeight;
export const selectIsSettingsOpen = (context: RuntimePanelContext): boolean =>
  context.isSettingsOpen;
export const selectConsoleLines = (context: RuntimePanelContext): string[] => context.consoleLines;
export const selectTerminalScrollLines = (
  context: RuntimePanelContext,
): RuntimeTerminalScrollLines => context.terminalScrollLines;
export const selectPlaybackSnapshot = (
  context: RuntimePanelContext,
): RuntimeRecordingSnapshot | null => context.playbackSnapshot;

/** Project the recordable subset captured into the runtime snapshot during recording. */
export const selectRecordingState = (context: RuntimePanelContext): RuntimePanelRecordingState => ({
  activeTab: context.activeTab,
  isCollapsed: context.isCollapsed,
  isFullHeight: context.isFullHeight,
  isSettingsOpen: context.isSettingsOpen,
  consoleLines: context.consoleLines,
  terminalScrollLines: context.terminalScrollLines,
});
