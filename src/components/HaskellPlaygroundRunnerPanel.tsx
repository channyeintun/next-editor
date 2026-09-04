import { useEffect, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import { Bot, ChevronDown, ChevronUp, Maximize2, Minimize2, SquareFunction } from "lucide-react";
import { signInUrl, useAuth } from "@next-editor/infra";
import AgentPanel from "./agent/AgentPanel";
import {
  STUDIO_TARGET_ATTRIBUTE,
  STUDIO_RUN_BUTTON_TARGET_ID,
  STUDIO_HASKELL_DOCK_TARGET_ID,
} from "../studio/targets";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import {
  selectActiveTab,
  selectConsoleLines,
  selectIsCollapsed,
  selectIsFullHeight,
  selectTerminalScrollLines,
} from "../stores/runtimePanelStore";
import XtermTerminal from "./XtermTerminal";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { useRuntimeDockRecordedSnapshot } from "../hooks/useRuntimeDockRecordedSnapshot";
import { useHaskellPlaygroundRunner } from "../hooks/useHaskellPlaygroundRunner";
import { useWorkspaceActions, useWorkspaceProjectVersion } from "../hooks/useWorkspace";
import {
  HASKELL_CONSOLE_TAG_PATTERN,
  haskellRunResultToConsoleLines,
  haskellRunServiceErrorToConsoleLines,
  haskellRunStartedConsoleLines,
} from "../runtime/haskellPlayground/console";
import { collectHaskellPlaygroundFiles } from "../runtime/haskellPlayground/files";
import {
  appendRunnerConsoleLines,
  clearRunnerConsole,
  resetRunnerConsoleForProject,
} from "../runtime/playgroundConsoleStore";
import type { RuntimeDockTab, RuntimeTerminalScrollLines } from "../types/runtime";
import { areStructuredDataEqual } from "../utils/equality";

/**
 * Focused Run console for Haskell lessons — deliberately not a Terminal,
 * mirroring GoPlaygroundRunnerPanel. Code executes remotely through the
 * play.haskell.org proxy on an explicit Run action; there is no shell,
 * preview, or WebContainer surface here, and no Format button because the
 * upstream service exposes a single /submit route and no formatter endpoint.
 * The upstream compiles one module from a single source string, so lessons run
 * exactly one Main.hs — capital M, because GHC's diagnostics name the file
 * Main.hs and the editor file has to match what the errors point at. Console
 * output lives in the shared runtime panel store's consoleLines, so the
 * existing runtime recording snapshot captures it and playback replays it
 * without any live execution. The dock also hosts the Agent tab: the agent
 * runs with file tools only in Haskell lessons (no bash or runtime
 * observation — see agent/tools/index.ts).
 */

const HASKELL_CONSOLE_SCROLL_SURFACE = "haskell-runner";

const ANSI_RESET = "\u001b[0m";
const ANSI_DIM = "\u001b[90m";
const ANSI_GREEN = "\u001b[92m";
const ANSI_RED = "\u001b[91m";
const ANSI_YELLOW = "\u001b[93m";

// Same prefix-coloring idiom as the other dock consoles: color the [tag], dim
// the rest, leave raw program output undecorated. GHC warns far more readily
// than it errors, so — as in the Kotlin console — the [haskell-warn] tag gets
// its own color rather than reading as a success line. Only the tags the
// Haskell console module emits match, so a program's own bracketed line —
// `print [1,2,3]` — is left alone.
function decorateHaskellConsoleLine(line: string): string {
  const prefixMatch = line.match(HASKELL_CONSOLE_TAG_PATTERN);

  if (!prefixMatch) {
    return line;
  }

  const prefix = prefixMatch[0];
  const suffix = line.slice(prefix.length);
  const prefixColor = prefix.includes("error")
    ? ANSI_RED
    : prefix.startsWith("[haskell-warn")
      ? ANSI_YELLOW
      : ANSI_GREEN;

  return `${prefixColor}${prefix}${ANSI_RESET}${ANSI_DIM}${suffix}${ANSI_RESET}`;
}

// Haskell lessons have no shell or preview, but the agent works on the
// workspace files, so the dock exposes two tabs: the Playground runner and
// the agent.
const HASKELL_DOCK_TABS = [
  {
    id: "runner",
    label: "Haskell Runner",
    icon: <SquareFunction size={15} strokeWidth={2.25} />,
  },
  {
    id: "agent",
    label: "Agent",
    icon: <Bot size={14} />,
  },
] as const satisfies readonly { id: RuntimeDockTab; label: string; icon: React.ReactNode }[];

interface HaskellRuntimeEventState {
  activeTab: RuntimeDockTab;
  isCollapsed: boolean;
  isFullHeight: boolean;
  consoleLines: string[];
  terminalScrollLines: RuntimeTerminalScrollLines;
}

/** null when the workspace does not contain exactly one Haskell file named Main.hs. */
function collectSingleHaskellLessonFile(
  project: Parameters<typeof collectHaskellPlaygroundFiles>[0],
): ReturnType<typeof collectHaskellPlaygroundFiles> | null {
  const files = collectHaskellPlaygroundFiles(project);
  return files.length === 1 && files[0].path === "Main.hs" ? files : null;
}

function HaskellPlaygroundRunnerPanel() {
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const activeTab = useSelector(runtimePanelStore, (s) => selectActiveTab(s.context));
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
  const { isRunning, run, cancel } = useHaskellPlaygroundRunner();
  const previousRuntimeEventStateRef = useRef<HaskellRuntimeEventState | null>(null);

  // The tab state is shared with the WebContainer dock's store; anything other
  // than "agent" (including a stale "terminal"/"console" from a previous lesson)
  // renders as the Haskell Runner tab.
  const rawActiveTab = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.activeTab ?? "runner")
    : activeTab;
  const displayActiveTab: RuntimeDockTab = rawActiveTab === "agent" ? "agent" : "runner";
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
    // The runtime panel store is shared by the browser and playground
    // runners. Clear their content-specific console/scroll state at
    // Haskell/project boundaries so output cannot leak into another lesson. A
    // project change also supersedes a run started against the previous file.
    cancel();

    resetRunnerConsoleForProject(runtimePanelStore);
    return () => resetRunnerConsoleForProject(runtimePanelStore);
  }, [cancel, projectVersion, runtimePanelStore]);

  useEffect(() => {
    if (isPlaybackSnapshotActive) {
      cancel();
    }
  }, [cancel, isPlaybackSnapshotActive]);

  const appendConsoleLines = (lines: string[]) => {
    appendRunnerConsoleLines(runtimePanelStore, lines);
  };

  const updateScrollLine = (scrollLine: number) => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    const current = runtimePanelStore.getSnapshot().context.terminalScrollLines;
    if (current[HASKELL_CONSOLE_SCROLL_SURFACE] === scrollLine) {
      return;
    }

    runtimePanelStore.trigger.setTerminalScrollLines({
      terminalScrollLines: { ...current, [HASKELL_CONSOLE_SCROLL_SURFACE]: scrollLine },
    });
  };

  const runtimeEventState: HaskellRuntimeEventState = {
    activeTab,
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

    // Read the current Haskell source at click time — never a stale copy.
    const project = getProject();
    const haskellFiles = collectSingleHaskellLessonFile(project);

    if (!haskellFiles) {
      appendConsoleLines(["[haskell-run error] Haskell lessons run a single Main.hs file"]);
      return;
    }

    appendConsoleLines(haskellRunStartedConsoleLines());
    const outcome = await run(haskellFiles);

    // A newer Run owns the console from here on.
    if (outcome.kind === "superseded") {
      return;
    }

    appendConsoleLines(
      outcome.kind === "result"
        ? haskellRunResultToConsoleLines(outcome.result)
        : haskellRunServiceErrorToConsoleLines(outcome.errorKind, outcome.message),
    );
  };

  const handleSignIn = async () => {
    // Persist edits before the full-page OAuth navigation so Run-after-sign-in
    // resumes with the same sources.
    await saveProject();
    window.location.assign(signInUrl(`${window.location.pathname}${window.location.search}`));
  };

  const showSignIn = !isPlaybackSnapshotActive && !isAuthLoading && !isSignedIn;
  const consoleContent = effectiveConsoleLines.map(decorateHaskellConsoleLine).join("\n");
  const dockContentSizeClass =
    displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "h-72";

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-t-md bg-[#15191f] ${
        displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "shrink-0"
      }`}
      data-cursor-replay-target="runtime-dock"
      {...{ [STUDIO_TARGET_ATTRIBUTE]: STUDIO_HASKELL_DOCK_TARGET_ID }}
    >
      <div className="flex items-center border-b border-[#11151d] bg-[#1e2129] px-2">
        {HASKELL_DOCK_TABS.map((tab) => {
          const isActive = tab.id === displayActiveTab;

          return (
            <button
              key={tab.id}
              data-tour={tab.id === "agent" ? "agent" : undefined}
              type="button"
              disabled={isPlaybackSnapshotActive}
              onClick={() => runtimePanelStore.trigger.setActiveTab({ tab: tab.id })}
              className={`inline-flex items-center gap-2.5 border-r border-[#11151d] px-4 py-3 text-[13px] font-semibold transition-colors ${
                isActive
                  ? "border-b border-b-[#64a3ff] bg-[#171b22] text-white"
                  : "text-slate-400 hover:bg-[#171b22] hover:text-white"
              } disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-slate-400`}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}

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

      {!displayIsCollapsed && displayActiveTab === "agent" && (
        <AgentPanel isFullHeight={dockContentSizeClass !== "h-72"} />
      )}

      {!displayIsCollapsed && displayActiveTab === "runner" && (
        <div className={`flex ${dockContentSizeClass} flex-col bg-[#15191f]`}>
          <div className="flex min-h-15.5 items-center justify-between border-b border-[#11151d] bg-[#191d25] px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <p className="truncate font-mono text-[13px] font-semibold text-slate-400">
                runghc Main.hs
              </p>
              {isRunning ? (
                <span
                  aria-label="Program is running"
                  className="inline-block size-2.5 shrink-0 animate-spin rounded-full border-2 border-[#d48a37] border-t-transparent"
                />
              ) : null}
            </div>
            <div className="ml-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  clearRunnerConsole(runtimePanelStore, HASKELL_CONSOLE_SCROLL_SURFACE);
                }}
                disabled={isPlaybackSnapshotActive || effectiveConsoleLines.length === 0}
                className="rounded-md px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-slate-400 transition-colors hover:bg-[#222831] hover:text-white disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent disabled:hover:text-slate-600"
                title="Clear the console"
              >
                Clear
              </button>
              {showSignIn ? (
                <button
                  type="button"
                  onClick={() => {
                    void handleSignIn();
                  }}
                  className="rounded-md bg-[#173925] px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-[#58d88d] transition-colors hover:bg-[#1f4a31] hover:text-[#75efa6]"
                >
                  Sign in to run Haskell
                </button>
              ) : (
                <button
                  type="button"
                  {...{ [STUDIO_TARGET_ATTRIBUTE]: STUDIO_RUN_BUTTON_TARGET_ID }}
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
              sessionId={HASKELL_CONSOLE_SCROLL_SURFACE}
              output={consoleContent}
              interactive={false}
              scrollLine={
                isPlaybackSnapshotActive
                  ? effectiveScrollLines[HASKELL_CONSOLE_SCROLL_SURFACE]
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

export default HaskellPlaygroundRunnerPanel;
