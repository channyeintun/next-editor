import { useEffect, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import { Bot, ChevronDown, ChevronUp, Cpu, Maximize2, Minimize2 } from "lucide-react";
import AgentPanel from "./agent/AgentPanel";
import {
  STUDIO_TARGET_ATTRIBUTE,
  STUDIO_RUN_BUTTON_TARGET_ID,
  STUDIO_ASM_DOCK_TARGET_ID,
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
import { useAsmPlaygroundRunner } from "../hooks/useAsmPlaygroundRunner";
import { useWorkspaceActions, useWorkspaceProjectVersion } from "../hooks/useWorkspace";
import {
  asmRegisterConsoleLines,
  asmRunResultToConsoleLines,
  asmRunServiceErrorToConsoleLines,
  asmRunStartedConsoleLines,
} from "../runtime/asmPlayground/console";
import { collectAsmPlaygroundFiles } from "../runtime/asmPlayground/files";
import { appendRunnerConsoleLines, clearRunnerConsole } from "../runtime/playgroundConsoleStore";
import type { RuntimeDockTab, RuntimeTerminalScrollLines } from "../types/runtime";
import { areStructuredDataEqual } from "../utils/equality";

/**
 * Focused Run console for x86-64 assembly lessons, mirroring
 * KitePlaygroundRunnerPanel.
 *
 * Like Kite's and unlike the four proxied languages, **there is no service**:
 * the assembler and the machine are TypeScript in `src/core/x86`, so Run
 * assembles and executes in this page and answers without a network round trip
 * — no proxy, no sign-in button, no rate limit, and no lesson that breaks
 * because a public playground went down. That is why this panel has no auth
 * branch at all where the other four have one. It has no Format button either,
 * for the plainer reason that assembly has no formatter to run.
 *
 * There is no linker here, so a run assembles `main.asm` alone (the client says
 * so plainly when several files exist and none is named that). After a run the
 * console also prints the registers the program changed, because an assembly
 * lesson is usually *about* the register file — and because those lines go
 * through the same console state as every other line, a recording captures them
 * and playback replays them with no live execution. The dock also hosts the
 * Agent tab, with file tools only, as in the other Playground lessons.
 */

const ASM_CONSOLE_SCROLL_SURFACE = "asm-runner";

const ANSI_RESET = "\u001b[0m";
const ANSI_DIM = "\u001b[90m";
const ANSI_GREEN = "\u001b[92m";
const ANSI_RED = "\u001b[91m";

// Same prefix-coloring idiom as the other dock consoles: color the [tag], dim
// the rest, leave raw program output undecorated.
function decorateAsmConsoleLine(line: string): string {
  const prefixMatch = line.match(/^\[[^\]]+\]/);

  if (!prefixMatch) {
    return line;
  }

  const prefix = prefixMatch[0];
  const suffix = line.slice(prefix.length);
  const prefixColor = prefix.includes("error") ? ANSI_RED : ANSI_GREEN;

  return `${prefixColor}${prefix}${ANSI_RESET}${ANSI_DIM}${suffix}${ANSI_RESET}`;
}

// Assembly lessons have no shell or preview, but the agent works on the
// workspace files, so the dock exposes two tabs: the runner and the agent.
const ASM_DOCK_TABS = [
  {
    id: "runner",
    label: "Assembly Runner",
    icon: <Cpu size={15} strokeWidth={2.25} />,
  },
  {
    id: "agent",
    label: "Agent",
    icon: <Bot size={14} />,
  },
] as const satisfies readonly { id: RuntimeDockTab; label: string; icon: React.ReactNode }[];

interface AsmRuntimeEventState {
  activeTab: RuntimeDockTab;
  isCollapsed: boolean;
  isFullHeight: boolean;
  consoleLines: string[];
  terminalScrollLines: RuntimeTerminalScrollLines;
}

function AsmPlaygroundRunnerPanel() {
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
  const { getProject } = useWorkspaceActions();
  const projectVersion = useWorkspaceProjectVersion();
  const { isRunning, run, cancel } = useAsmPlaygroundRunner();
  const previousRuntimeEventStateRef = useRef<AsmRuntimeEventState | null>(null);

  // The tab state is shared with the WebContainer dock's store; anything other
  // than "agent" (including a stale "terminal"/"console" from a previous lesson)
  // renders as the runner tab.
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
    // The runtime panel store is shared by the browser and playground runners.
    // Clear their content-specific console/scroll state at project boundaries
    // so output cannot leak into another lesson. A project change also
    // supersedes a run started against the previous file.
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
    appendRunnerConsoleLines(runtimePanelStore, lines);
  };

  const updateScrollLine = (scrollLine: number) => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    const current = runtimePanelStore.getSnapshot().context.terminalScrollLines;
    if (current[ASM_CONSOLE_SCROLL_SURFACE] === scrollLine) {
      return;
    }

    runtimePanelStore.trigger.setTerminalScrollLines({
      terminalScrollLines: { ...current, [ASM_CONSOLE_SCROLL_SURFACE]: scrollLine },
    });
  };

  const runtimeEventState: AsmRuntimeEventState = {
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

    // Read the current sources at click time — never a stale copy. Which one is
    // the program is the client's call, so a workspace it cannot resolve comes
    // back as its own message rather than a guess here.
    const project = getProject();
    const asmFiles = collectAsmPlaygroundFiles(project);

    appendConsoleLines(asmRunStartedConsoleLines());
    const outcome = await run(asmFiles);

    // A newer Run owns the console from here on.
    if (outcome.kind === "superseded") {
      return;
    }

    appendConsoleLines(
      outcome.kind === "result"
        ? [
            ...asmRunResultToConsoleLines(outcome.result),
            ...asmRegisterConsoleLines(outcome.result),
          ]
        : asmRunServiceErrorToConsoleLines(outcome.errorKind, outcome.message),
    );
  };

  const consoleContent = effectiveConsoleLines.map(decorateAsmConsoleLine).join("\n");
  const dockContentSizeClass =
    displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "h-72";

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-t-md bg-[#15191f] ${
        displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "shrink-0"
      }`}
      data-cursor-replay-target="runtime-dock"
      {...{ [STUDIO_TARGET_ATTRIBUTE]: STUDIO_ASM_DOCK_TARGET_ID }}
    >
      <div className="flex items-center border-b border-[#11151d] bg-[#1e2129] px-2">
        {ASM_DOCK_TABS.map((tab) => {
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
                nasm -f elf64 main.asm &amp;&amp; ld -o main main.o &amp;&amp; ./main
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
                  clearRunnerConsole(runtimePanelStore, ASM_CONSOLE_SCROLL_SURFACE);
                }}
                disabled={isPlaybackSnapshotActive || effectiveConsoleLines.length === 0}
                className="rounded-md px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-slate-400 transition-colors hover:bg-[#222831] hover:text-white disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent disabled:hover:text-slate-600"
                title="Clear the console"
              >
                Clear
              </button>
              <button
                type="button"
                {...{ [STUDIO_TARGET_ATTRIBUTE]: STUDIO_RUN_BUTTON_TARGET_ID }}
                onClick={() => {
                  void handleRun();
                }}
                disabled={isPlaybackSnapshotActive}
                className="rounded-md bg-[#173925] px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-[#58d88d] transition-colors hover:bg-[#1f4a31] hover:text-[#75efa6] disabled:cursor-not-allowed disabled:bg-[#17241e] disabled:text-[#4f8e68]"
              >
                Run
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden px-5 py-6 bg-[#15191f]">
            <XtermTerminal
              sessionId={ASM_CONSOLE_SCROLL_SURFACE}
              output={consoleContent}
              interactive={false}
              scrollLine={
                isPlaybackSnapshotActive
                  ? effectiveScrollLines[ASM_CONSOLE_SCROLL_SURFACE]
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

export default AsmPlaygroundRunnerPanel;
