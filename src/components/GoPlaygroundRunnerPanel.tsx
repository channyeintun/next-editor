import { useEffect, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import { ChevronDown, ChevronUp, Diamond, Maximize2, Minimize2 } from "lucide-react";
import { signInUrl, useAuth } from "@next-editor/infra";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import {
  selectConsoleLines,
  selectIsCollapsed,
  selectIsFullHeight,
  selectTerminalScrollLines,
} from "../stores/runtimePanelStore";
import XtermTerminal from "./XtermTerminal";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { useRuntimeDockRecordedSnapshot } from "../hooks/useRuntimeDockRecordedSnapshot";
import { useGoPlaygroundRunner } from "../hooks/useGoPlaygroundRunner";
import { useWorkspaceActions, useWorkspaceProjectVersion } from "../hooks/useWorkspace";
import { isWorkspaceTextFile } from "../types/workspace";
import {
  goRunResultToConsoleLines,
  goRunServiceErrorToConsoleLines,
  goRunStartedConsoleLines,
} from "../runtime/goPlayground/console";
import type { RuntimeTerminalScrollLines } from "../types/runtime";
import { areStructuredDataEqual } from "../utils/equality";

/**
 * Focused Run console for Go lessons — deliberately not a Terminal. Code
 * executes remotely through the Go Playground proxy on an explicit Run
 * action; there is no shell, preview, or WebContainer surface here. Console
 * output lives in the shared runtime panel store's consoleLines, so the
 * existing runtime recording snapshot captures it and playback replays it
 * without any live execution.
 */

const GO_CONSOLE_SCROLL_SURFACE = "go-runner";
// Bounds the recorded console state — every runtime recording event snapshots
// the full line array, so an unbounded log would bloat .ne recordings.
const MAX_GO_CONSOLE_LINES = 200;

const ANSI_RESET = "\u001b[0m";
const ANSI_DIM = "\u001b[90m";
const ANSI_GREEN = "\u001b[92m";
const ANSI_RED = "\u001b[91m";
const ANSI_YELLOW = "\u001b[93m";

// Same prefix-coloring idiom as the WebContainer dock's console: color the
// [tag], dim the rest, leave raw program output undecorated.
function decorateGoConsoleLine(line: string): string {
  const prefixMatch = line.match(/^\[[^\]]+\]/);

  if (!prefixMatch) {
    return line;
  }

  const prefix = prefixMatch[0];
  const suffix = line.slice(prefix.length);
  const prefixColor = prefix.includes("error")
    ? ANSI_RED
    : prefix.startsWith("[go-vet")
      ? ANSI_YELLOW
      : ANSI_GREEN;

  return `${prefixColor}${prefix}${ANSI_RESET}${ANSI_DIM}${suffix}${ANSI_RESET}`;
}

interface GoRuntimeEventState {
  isCollapsed: boolean;
  isFullHeight: boolean;
  consoleLines: string[];
  terminalScrollLines: RuntimeTerminalScrollLines;
}

function GoPlaygroundRunnerPanel() {
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const isCollapsed = useSelector(runtimePanelStore, (s) => selectIsCollapsed(s.context));
  const isFullHeight = useSelector(runtimePanelStore, (s) => selectIsFullHeight(s.context));
  const consoleLines = useSelector(runtimePanelStore, (s) => selectConsoleLines(s.context));
  const terminalScrollLines = useSelector(runtimePanelStore, (s) =>
    selectTerminalScrollLines(s.context),
  );
  const { handleRuntimeEvent } = useNextEditorActions();
  const { currentRecording, isRecording } = useNextEditorMetadata();
  const { recordedRuntimeSnapshot, isPlaybackSnapshotActive } = useRuntimeDockRecordedSnapshot();
  const { getProject, saveProject } = useWorkspaceActions();
  const projectVersion = useWorkspaceProjectVersion();
  const { isSignedIn, isLoading: isAuthLoading } = useAuth();
  const { isRunning, run, cancel } = useGoPlaygroundRunner();
  const previousRuntimeEventStateRef = useRef<GoRuntimeEventState | null>(null);

  const displayIsCollapsed = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.isCollapsed ?? false)
    : isCollapsed;
  const displayIsFullHeight = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.isFullHeight ?? false)
    : isFullHeight;
  const effectiveConsoleLines = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.consoleLines ?? [])
    : consoleLines;
  const effectiveScrollLines = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.terminalScrollLines ?? {})
    : terminalScrollLines;

  useEffect(() => {
    if (!currentRecording) {
      runtimePanelStore.trigger.setPlaybackSnapshot({ snapshot: null });
    }
  }, [currentRecording, runtimePanelStore]);

  useEffect(() => {
    // The runtime panel store is shared by the browser and Go runners. Clear
    // their content-specific console/scroll state at Go/project boundaries so
    // output cannot leak into another lesson. A project change also supersedes
    // a Run that was started against the previous main.go.
    cancel();

    const resetConsoleSurface = () => {
      const context = runtimePanelStore.getSnapshot().context;
      if (context.consoleLines.length > 0) {
        runtimePanelStore.trigger.setConsoleLines({ consoleLines: [] });
      }

      if (Object.keys(context.terminalScrollLines).length > 0) {
        runtimePanelStore.trigger.setTerminalScrollLines({
          terminalScrollLines: {},
        });
      }
    };

    resetConsoleSurface();
    return resetConsoleSurface;
  }, [cancel, projectVersion, runtimePanelStore]);

  useEffect(() => {
    if (isPlaybackSnapshotActive) {
      cancel();
    }
  }, [cancel, isPlaybackSnapshotActive]);

  const appendConsoleLines = (lines: string[]) => {
    if (lines.length === 0) {
      return;
    }

    const current = runtimePanelStore.getSnapshot().context.consoleLines;
    // Blank separator between runs keeps consecutive results readable.
    const separator = current.length > 0 && lines[0].startsWith("[go-run] go run") ? [""] : [];
    runtimePanelStore.trigger.setConsoleLines({
      consoleLines: [...current, ...separator, ...lines].slice(-MAX_GO_CONSOLE_LINES),
    });
  };

  const updateScrollLine = (scrollLine: number) => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    const current = runtimePanelStore.getSnapshot().context.terminalScrollLines;
    if (current[GO_CONSOLE_SCROLL_SURFACE] === scrollLine) {
      return;
    }

    runtimePanelStore.trigger.setTerminalScrollLines({
      terminalScrollLines: { ...current, [GO_CONSOLE_SCROLL_SURFACE]: scrollLine },
    });
  };

  const runtimeEventState: GoRuntimeEventState = {
    isCollapsed,
    isFullHeight,
    consoleLines,
    terminalScrollLines,
  };

  useEffect(() => {
    if (!isRecording || isPlaybackSnapshotActive) {
      previousRuntimeEventStateRef.current = runtimeEventState;
      return;
    }

    if (previousRuntimeEventStateRef.current === null) {
      previousRuntimeEventStateRef.current = runtimeEventState;
      return;
    }

    if (!areStructuredDataEqual(previousRuntimeEventStateRef.current, runtimeEventState)) {
      previousRuntimeEventStateRef.current = runtimeEventState;
      handleRuntimeEvent();
    }
  }, [handleRuntimeEvent, isPlaybackSnapshotActive, isRecording, runtimeEventState]);

  const handleRun = async () => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    // Read the current source at click time — never a stale copy.
    const project = getProject();
    const goFiles = Object.values(project.files).filter(
      (file) => file.path.endsWith(".go") && isWorkspaceTextFile(file),
    );
    const goFile = project.files["main.go"];

    if (!goFile || !isWorkspaceTextFile(goFile)) {
      appendConsoleLines(["[go-run error] Add a main.go file to run this lesson"]);
      return;
    }
    if (goFiles.length !== 1) {
      appendConsoleLines(["[go-run error] Go lessons currently support exactly one main.go file"]);
      return;
    }

    appendConsoleLines(goRunStartedConsoleLines(goFile.name));
    const outcome = await run(goFile.content);

    // A newer Run owns the console from here on.
    if (outcome.kind === "superseded") {
      return;
    }

    appendConsoleLines(
      outcome.kind === "result"
        ? goRunResultToConsoleLines(outcome.result)
        : goRunServiceErrorToConsoleLines(outcome.errorKind, outcome.message),
    );
  };

  const handleSignIn = async () => {
    // Persist edits before the full-page OAuth navigation so Run-after-sign-in
    // resumes with the same source.
    await saveProject();
    window.location.assign(signInUrl(`${window.location.pathname}${window.location.search}`));
  };

  const showSignIn = !isPlaybackSnapshotActive && !isAuthLoading && !isSignedIn;
  const consoleContent =
    effectiveConsoleLines.length === 0
      ? "Press Run to compile and run this lesson's Go program with the Go Playground."
      : effectiveConsoleLines.map(decorateGoConsoleLine).join("\n");
  const dockContentSizeClass =
    displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "h-72";

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-t-md bg-[#15191f] ${
        displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "shrink-0"
      }`}
      data-cursor-replay-target="runtime-dock"
    >
      <div className="flex items-center border-b border-[#11151d] bg-[#1e2129] px-2">
        <div className="inline-flex items-center gap-2.5 border-b border-b-[#64a3ff] border-r border-r-[#11151d] bg-[#171b22] px-4 py-3 text-[13px] font-semibold text-white">
          <Diamond size={15} strokeWidth={2.25} />
          Go Runner
        </div>

        <button
          type="button"
          disabled={isPlaybackSnapshotActive || displayIsCollapsed}
          onClick={() => {
            runtimePanelStore.trigger.setIsFullHeight({
              fullHeight: !runtimePanelStore.getSnapshot().context.isFullHeight,
            });
          }}
          className="ml-auto inline-flex items-center justify-center text-slate-500 transition-colors hover:text-white size-10 disabled:cursor-default disabled:opacity-40 disabled:hover:text-slate-500"
          aria-label={
            displayIsFullHeight
              ? "Restore runtime dock height"
              : "Expand runtime dock to full height"
          }
          title={
            displayIsFullHeight
              ? "Restore runtime dock height"
              : "Expand runtime dock to full height"
          }
        >
          {displayIsFullHeight ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>

        <button
          type="button"
          disabled={isPlaybackSnapshotActive}
          onClick={() => {
            runtimePanelStore.trigger.setIsCollapsed({
              collapsed: !runtimePanelStore.getSnapshot().context.isCollapsed,
            });
          }}
          className="inline-flex items-center justify-center text-slate-500 transition-colors hover:text-white size-10 disabled:cursor-default disabled:hover:text-slate-500"
          aria-label={displayIsCollapsed ? "Expand runtime dock" : "Collapse runtime dock"}
          title={displayIsCollapsed ? "Expand runtime dock" : "Collapse runtime dock"}
        >
          {displayIsCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {!displayIsCollapsed && (
        <div className={`flex ${dockContentSizeClass} flex-col bg-[#15191f]`}>
          <div className="flex min-h-15.5 items-center justify-between border-b border-[#11151d] bg-[#191d25] px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <p className="truncate font-mono text-[13px] font-semibold text-slate-400">
                go run main.go
              </p>
              {isRunning ? (
                <span
                  aria-label="Program is compiling and running"
                  className="inline-block size-2.5 shrink-0 animate-spin rounded-full border-2 border-[#d48a37] border-t-transparent"
                />
              ) : null}
            </div>
            <div className="ml-4 flex items-center gap-2">
              {showSignIn ? (
                <button
                  type="button"
                  onClick={() => {
                    void handleSignIn();
                  }}
                  className="rounded-md bg-[#173925] px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-[#58d88d] transition-colors hover:bg-[#1f4a31] hover:text-[#75efa6]"
                >
                  Sign in to Run
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    void handleRun();
                  }}
                  disabled={isPlaybackSnapshotActive || isAuthLoading}
                  className="rounded-md bg-[#173925] px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-[#58d88d] transition-colors hover:bg-[#1f4a31] hover:text-[#75efa6] disabled:cursor-not-allowed disabled:bg-[#17241e] disabled:text-[#4f8e68]"
                >
                  Run
                </button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden px-5 py-6 bg-[#15191f]">
            <XtermTerminal
              sessionId={GO_CONSOLE_SCROLL_SURFACE}
              output={consoleContent}
              interactive={false}
              scrollLine={
                isPlaybackSnapshotActive
                  ? effectiveScrollLines[GO_CONSOLE_SCROLL_SURFACE]
                  : undefined
              }
              onScroll={updateScrollLine}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default GoPlaygroundRunnerPanel;
