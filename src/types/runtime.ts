export type RuntimeDockTab = "runner" | "terminal" | "console";

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
  lastOutput?: string | null;
  activeCommand?: string | null;
  errorMessage?: string | null;
}

export interface RuntimeRecordingEvent {
  timestamp: number;
  snapshot: RuntimeRecordingSnapshot;
}
