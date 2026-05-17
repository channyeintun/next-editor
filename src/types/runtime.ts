export type RuntimeDockTab = "runner" | "terminal" | "console";

export type RuntimeTerminalEventType =
  | "session-created"
  | "session-closed"
  | "session-activated"
  | "output"
  | "resize";

export interface RuntimeTerminalEvent {
  id: number;
  timestamp: number;
  type: RuntimeTerminalEventType;
  sessionId: string;
  chunk?: string;
  cols?: number;
  rows?: number;
  title?: string;
}

export interface RuntimeTerminalSessionSnapshot {
  id: string;
  title: string;
  output: string;
}

export interface RuntimePanelRecordingState {
  activeTab?: RuntimeDockTab;
  isCollapsed?: boolean;
  isSettingsOpen?: boolean;
  consoleLines?: string[];
}

export interface RuntimeRecordingSnapshot extends RuntimePanelRecordingState {
  mode: "single-file" | "webcontainer";
  status: string;
  previewUrl?: string | null;
  terminalOutput?: string | null;
  terminalSessions?: RuntimeTerminalSessionSnapshot[];
  terminalEvents?: RuntimeTerminalEvent[];
  terminalEventCount?: number;
  activeTerminalSessionId?: string | null;
  activeCommand?: string | null;
  errorMessage?: string | null;
}

export interface RuntimeRecordingEvent {
  timestamp: number;
  snapshot: RuntimeRecordingSnapshot;
}
