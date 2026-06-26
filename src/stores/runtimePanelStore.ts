import type {
  RuntimeDockTab,
  RuntimePanelRecordingState,
  RuntimeRecordingSnapshot,
  RuntimeTerminalScrollLines,
} from "../types/runtime";

export interface RuntimePanelStoreState {
  activeTab: RuntimeDockTab;
  isCollapsed: boolean;
  isSettingsOpen: boolean;
  consoleLines: string[];
  terminalScrollLines: RuntimeTerminalScrollLines;
  playbackSnapshot: RuntimeRecordingSnapshot | null;
}

export type ConsoleAppender = (message: string) => void;
export type ConsoleOpener = () => void;

export interface RuntimePanelStore {
  getState: () => RuntimePanelStoreState;
  subscribe: (listener: () => void) => () => void;
  setActiveTab: (tab: RuntimeDockTab) => void;
  setIsCollapsed: (collapsed: boolean) => void;
  setIsSettingsOpen: (open: boolean) => void;
  setConsoleLines: (updater: string[] | ((prev: string[]) => string[])) => void;
  setTerminalScrollLines: (
    updater:
      | RuntimeTerminalScrollLines
      | ((prev: RuntimeTerminalScrollLines) => RuntimeTerminalScrollLines),
  ) => void;
  setPlaybackSnapshot: (snapshot: RuntimeRecordingSnapshot | null) => void;
  getRecordingState: () => RuntimePanelRecordingState;
  consoleAppender: { current: ConsoleAppender | null };
  consoleOpener: { current: ConsoleOpener | null };
}

const DEFAULT_STATE: RuntimePanelStoreState = {
  activeTab: "runner",
  isCollapsed: false,
  isSettingsOpen: false,
  consoleLines: [],
  terminalScrollLines: {},
  playbackSnapshot: null,
};

export function createRuntimePanelStore(): RuntimePanelStore {
  let state: RuntimePanelStoreState = { ...DEFAULT_STATE };
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const consoleAppender: { current: ConsoleAppender | null } = { current: null };
  const consoleOpener: { current: ConsoleOpener | null } = { current: null };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setActiveTab: (tab) => {
      if (tab !== state.activeTab) {
        state = { ...state, activeTab: tab };
        notify();
      }
    },
    setIsCollapsed: (collapsed) => {
      if (collapsed !== state.isCollapsed) {
        state = { ...state, isCollapsed: collapsed };
        notify();
      }
    },
    setIsSettingsOpen: (open) => {
      if (open !== state.isSettingsOpen) {
        state = { ...state, isSettingsOpen: open };
        notify();
      }
    },
    setConsoleLines: (updater) => {
      const next = typeof updater === "function" ? updater(state.consoleLines) : updater;
      if (next !== state.consoleLines) {
        state = { ...state, consoleLines: next };
        notify();
      }
    },
    setTerminalScrollLines: (updater) => {
      const next = typeof updater === "function" ? updater(state.terminalScrollLines) : updater;
      if (next !== state.terminalScrollLines) {
        state = { ...state, terminalScrollLines: next };
        notify();
      }
    },
    setPlaybackSnapshot: (snapshot) => {
      if (snapshot !== state.playbackSnapshot) {
        state = { ...state, playbackSnapshot: snapshot };
        notify();
      }
    },
    getRecordingState: () => ({
      activeTab: state.activeTab,
      isCollapsed: state.isCollapsed,
      isSettingsOpen: state.isSettingsOpen,
      consoleLines: state.consoleLines,
      terminalScrollLines: state.terminalScrollLines,
    }),
    consoleAppender,
    consoleOpener,
  };
}
