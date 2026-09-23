export type RuntimeDockTab = "runner" | "terminal" | "console" | "agent";
export type RuntimeTerminalScrollLines = Record<string, number>;

export interface RuntimeTerminalSessionSnapshot {
  id: string;
  title: string;
  output: string;
}

export interface RuntimePanelRecordingState {
  activeTab?: RuntimeDockTab;
  isCollapsed?: boolean;
  isFullHeight?: boolean;
  isSettingsOpen?: boolean;
  consoleLines?: string[];
  terminalScrollLines?: RuntimeTerminalScrollLines;
}

export interface RuntimeRecordingSnapshot extends RuntimePanelRecordingState {
  mode: "single-file" | "webcontainer";
  status: string;
  previewUrl?: string | null;
  previewPort?: number | null;
  lastOutput?: string | null;
  activeCommand?: string | null;
  errorMessage?: string | null;
  terminalSessions?: RuntimeTerminalSessionSnapshot[];
  activeTerminalSessionId?: string | null;
  latestPreviewMessage?: {
    id: number;
    kind: "console-error" | "uncaught-exception" | "unhandled-rejection";
    text: string;
    port: number | null;
    pathname: string;
  } | null;
  latestLifecycleEvent?: {
    id: number;
    kind: "port-open" | "port-close" | "internal-error";
    text: string;
    port: number | null;
    url: string | null;
  } | null;
}

/**
 * How one terminal session's output changed since the previous runtime event:
 * drop `drop` characters from the front (the output is a rolling window, see
 * TERMINAL_OUTPUT_LIMIT), then append `append`. Replaying it is exact:
 * `previous.slice(drop) + append`.
 */
export interface RuntimeTerminalOutputDelta {
  drop: number;
  append: string;
}

export interface RuntimeTerminalSessionDelta {
  id: string;
  title: string;
  output: RuntimeTerminalOutputDelta;
}

/**
 * A runtime event that stores only what changed in terminal output. Every other
 * field is small and stored whole, exactly as in a snapshot. `terminalSessions`
 * lists every open session (a session left out was closed); each one's output is
 * relative to the same session id in the previous event's resolved state, and a
 * session that did not exist there starts from "".
 */
export type RuntimeRecordingDelta = Omit<RuntimeRecordingSnapshot, "terminalSessions"> & {
  terminalSessions?: RuntimeTerminalSessionDelta[];
};

/**
 * One runtime track entry: a full `snapshot` (a checkpoint — always the first
 * event, then sparse seek anchors) or a `delta` against the previous event.
 * Resolve an index to its state with `resolveRuntimeSnapshotAt`, never by
 * reading `snapshot` off an arbitrary event.
 */
export type RuntimeRecordingEvent =
  | { timestamp: number; snapshot: RuntimeRecordingSnapshot; delta?: undefined }
  | { timestamp: number; delta: RuntimeRecordingDelta; snapshot?: undefined };
