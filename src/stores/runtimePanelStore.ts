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
  isSettingsOpen: boolean;
  consoleLines: string[];
  terminalScrollLines: RuntimeTerminalScrollLines;
  playbackSnapshot: RuntimeRecordingSnapshot | null;
}

export type ConsoleAppender = (message: string) => void;
export type ConsoleOpener = () => void;

const DEFAULT_CONTEXT: RuntimePanelContext = {
  activeTab: "runner",
  isCollapsed: false,
  isSettingsOpen: false,
  consoleLines: [],
  terminalScrollLines: {},
  playbackSnapshot: null,
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
  isSettingsOpen: context.isSettingsOpen,
  consoleLines: context.consoleLines,
  terminalScrollLines: context.terminalScrollLines,
});
