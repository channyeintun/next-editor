import { useEffect, useEffectEvent, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import { Bot, ChevronDown, ChevronUp, Cog, Maximize2, Minimize2 } from "lucide-react";
import AgentPanel from "./agent/AgentPanel";
import {
  STUDIO_TARGET_ATTRIBUTE,
  STUDIO_RUN_BUTTON_TARGET_ID,
  STUDIO_KITE_DOCK_TARGET_ID,
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
import { useKitePlaygroundRunner } from "../hooks/useKitePlaygroundRunner";
import { useWorkspaceActions, useWorkspaceProjectVersion } from "../hooks/useWorkspace";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import { monaco, workspacePathFromMonacoModelUri } from "../monaco";
import {
  kiteFormatResultToConsoleLines,
  kiteFormatServiceErrorToConsoleLines,
  kiteFormatStaleConsoleLines,
  kiteFormatStartedConsoleLines,
  kiteRunResultToConsoleLines,
  kiteRunServiceErrorToConsoleLines,
  kiteRunStartedConsoleLines,
} from "../runtime/kitePlayground/console";
import {
  areKitePlaygroundFilesEqual,
  collectKitePlaygroundFiles,
} from "../runtime/kitePlayground/files";
import { appendRunnerConsoleLines, clearRunnerConsole } from "../runtime/playgroundConsoleStore";
import type { RuntimeDockTab, RuntimeTerminalScrollLines } from "../types/runtime";
import { areStructuredDataEqual } from "../utils/equality";

/**
 * Focused Run console for Kite lessons, mirroring RustPlaygroundRunnerPanel.
 *
 * The one difference is the one that matters: **there is no service**. `kitec`
 * is a Rust program, normally a native binary, and Rust builds for WebAssembly
 * too — so Run and Format instantiate a Wasm build of that same compiler in this
 * page and answer without a network round trip: no proxy, no sign-in button, no
 * rate limit, and no lesson that breaks because a public playground is down.
 * That is why this panel has no auth branch at all where the other three have
 * one.
 *
 * A Kite module is a directory, so every `.kite` file in the workspace is part
 * of the same program: Format touches all of them, and a run compiles
 * `main.kite` (the client says so plainly when several files exist and none is
 * named that). Console output lives in the shared runtime panel store's
 * consoleLines, so the existing runtime recording snapshot captures it and
 * playback replays it without any live execution. The dock also hosts the Agent
 * tab, with file tools only, as in the other Playground lessons.
 */

const KITE_CONSOLE_SCROLL_SURFACE = "kite-runner";

const ANSI_RESET = "\u001b[0m";
const ANSI_DIM = "\u001b[90m";
const ANSI_GREEN = "\u001b[92m";
const ANSI_RED = "\u001b[91m";

// Same prefix-coloring idiom as the other dock consoles: color the [tag], dim
// the rest, leave raw program output undecorated.
function decorateKiteConsoleLine(line: string): string {
  const prefixMatch = line.match(/^\[[^\]]+\]/);

  if (!prefixMatch) {
    return line;
  }

  const prefix = prefixMatch[0];
  const suffix = line.slice(prefix.length);
  const prefixColor = prefix.includes("error") ? ANSI_RED : ANSI_GREEN;

  return `${prefixColor}${prefix}${ANSI_RESET}${ANSI_DIM}${suffix}${ANSI_RESET}`;
}

// Kite lessons have no shell or preview, but the agent works on the workspace
// files, so the dock exposes two tabs: the Playground runner and the agent.
const KITE_DOCK_TABS = [
  {
    id: "runner",
    label: "Kite Runner",
    icon: <Cog size={15} strokeWidth={2.25} />,
  },
  {
    id: "agent",
    label: "Agent",
    icon: <Bot size={14} />,
  },
] as const satisfies readonly { id: RuntimeDockTab; label: string; icon: React.ReactNode }[];

interface KiteRuntimeEventState {
  activeTab: RuntimeDockTab;
  isCollapsed: boolean;
  isFullHeight: boolean;
  consoleLines: string[];
  terminalScrollLines: RuntimeTerminalScrollLines;
}

function KitePlaygroundRunnerPanel() {
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const activeTab = useSelector(runtimePanelStore, (s) => selectActiveTab(s.context));
  const isCollapsed = useSelector(runtimePanelStore, (s) => selectIsCollapsed(s.context));
  const isFullHeight = useSelector(runtimePanelStore, (s) => selectIsFullHeight(s.context));
  const consoleLines = useSelector(runtimePanelStore, (s) => selectConsoleLines(s.context));
  const terminalScrollLines = useSelector(runtimePanelStore, (s) =>
    selectTerminalScrollLines(s.context),
  );
  const { editorRef, handleRuntimeEvent } = useNextEditorActions();
  const { currentRecording, isRecording } = useNextEditorMetadata();
  const { recordedRuntimeSnapshot, isPlaybackSnapshotActive } = useRuntimeDockRecordedSnapshot();
  const { getProject, updateFileContent } = useWorkspaceActions();
  const projectVersion = useWorkspaceProjectVersion();
  const collaboration = useOptionalCollaboration();
  const { isRunning, isFormatting, run, format, cancel } = useKitePlaygroundRunner();
  const previousRuntimeEventStateRef = useRef<KiteRuntimeEventState | null>(null);

  // The tab state is shared with the WebContainer dock's store; anything other
  // than "agent" (including a stale "terminal"/"console" from a previous lesson)
  // renders as the Kite Runner tab.
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
  const canFormatWorkspace = !collaboration?.provider || collaboration.canWrite;
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
    // Kite/project boundaries so output cannot leak into another lesson. A
    // project change also supersedes a Kite tool request started against the
    // previous file.
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

  const formatKiteProject = async (
    activeModel: monaco.editor.ITextModel | null = null,
  ): Promise<monaco.languages.TextEdit[]> => {
    if (isPlaybackSnapshotActive) {
      return [];
    }
    if (!canFormatWorkspace) {
      appendConsoleLines(["[kitefmt error] This shared lesson is read-only"]);
      return [];
    }

    const project = getProject();
    const submittedFiles = collectKitePlaygroundFiles(project);
    if (submittedFiles.length === 0) {
      appendConsoleLines(["[kitefmt error] Add a .kite file to format this lesson"]);
      return [];
    }

    const activePath = activeModel ? workspacePathFromMonacoModelUri(activeModel.uri) : null;
    const activeModelVersion = activeModel?.getVersionId();
    const submittedActiveFile = activePath
      ? submittedFiles.find((file) => file.path === activePath)
      : null;
    if (
      activeModel &&
      (!submittedActiveFile || activeModel.getValue() !== submittedActiveFile.content)
    ) {
      appendConsoleLines(kiteFormatStaleConsoleLines());
      return [];
    }

    appendConsoleLines(kiteFormatStartedConsoleLines());
    const outcome = await format(submittedFiles);
    if (outcome.kind === "superseded") {
      return [];
    }
    if (outcome.kind === "service-error") {
      appendConsoleLines(kiteFormatServiceErrorToConsoleLines(outcome.errorKind, outcome.message));
      return [];
    }

    const currentProject = getProject();
    const currentFiles = collectKitePlaygroundFiles(currentProject);
    if (
      currentProject.id !== project.id ||
      !areKitePlaygroundFilesEqual(currentFiles, submittedFiles) ||
      activeModel?.isDisposed() ||
      (activeModel && activeModel.getVersionId() !== activeModelVersion) ||
      (activeModel && activeModel.getValue() !== submittedActiveFile?.content)
    ) {
      appendConsoleLines(kiteFormatStaleConsoleLines());
      return [];
    }

    // A Kite module is a directory, so a format can touch several files. Every
    // changed file except the open one is written straight to the workspace;
    // the open one comes back as an edit so Monaco keeps the undo stack.
    const submittedByPath = new Map(submittedFiles.map((file) => [file.path, file.content]));
    let changedAny = false;
    let activeEdits: monaco.languages.TextEdit[] = [];

    for (const formatted of outcome.result.files) {
      if (formatted.content === submittedByPath.get(formatted.path)) {
        continue;
      }
      changedAny = true;
      if (activeModel && formatted.path === activePath) {
        activeEdits = [{ range: activeModel.getFullModelRange(), text: formatted.content }];
      } else {
        updateFileContent(formatted.path, formatted.content);
      }
    }

    appendConsoleLines(kiteFormatResultToConsoleLines(changedAny));
    return activeEdits;
  };

  const provideKiteFormattingEdits = useEffectEvent(
    async (
      model: monaco.editor.ITextModel,
      _options: monaco.languages.FormattingOptions,
      token: monaco.CancellationToken,
    ) => {
      if (token.isCancellationRequested) {
        return [];
      }
      return formatKiteProject(model);
    },
  );

  useEffect(() => {
    // `.kite` files carry the first-party `kite` language id registered by
    // monaco/kiteLanguage.ts. This used to register against `rust`, because
    // that is the grammar Kite borrowed before it had one of its own.
    const disposable = monaco.languages.registerDocumentFormattingEditProvider("kite", {
      displayName: "kitec fmt (Kite)",
      provideDocumentFormattingEdits: provideKiteFormattingEdits,
    });
    return () => disposable.dispose();
  }, [provideKiteFormattingEdits]);

  const handleFormat = async () => {
    const editor = editorRef.current;
    if (editor?.getModel()?.getLanguageId() === "kite") {
      const action = editor.getAction("editor.action.formatDocument");
      if (action) {
        await action.run();
        return;
      }
    }
    await formatKiteProject();
  };

  const updateScrollLine = (scrollLine: number) => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    const current = runtimePanelStore.getSnapshot().context.terminalScrollLines;
    if (current[KITE_CONSOLE_SCROLL_SURFACE] === scrollLine) {
      return;
    }

    runtimePanelStore.trigger.setTerminalScrollLines({
      terminalScrollLines: { ...current, [KITE_CONSOLE_SCROLL_SURFACE]: scrollLine },
    });
  };

  const runtimeEventState: KiteRuntimeEventState = {
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

    // Read the current Kite sources at click time — never a stale copy. Which
    // one is the program is the client's call, so a workspace the compiler
    // cannot resolve comes back as its own message rather than a guess here.
    const project = getProject();
    const kiteFiles = collectKitePlaygroundFiles(project);

    appendConsoleLines(kiteRunStartedConsoleLines());
    const outcome = await run(kiteFiles);

    // A newer Run owns the console from here on.
    if (outcome.kind === "superseded") {
      return;
    }

    appendConsoleLines(
      outcome.kind === "result"
        ? kiteRunResultToConsoleLines(outcome.result)
        : kiteRunServiceErrorToConsoleLines(outcome.errorKind, outcome.message),
    );
  };

  const consoleContent = effectiveConsoleLines.map(decorateKiteConsoleLine).join("\n");
  const dockContentSizeClass =
    displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "h-72";
  const toolLabel = isFormatting ? "kitec fmt main.kite" : "kitec run main.kite";
  const isToolActive = isRunning || isFormatting;

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-t-md bg-[#15191f] ${
        displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "shrink-0"
      }`}
      data-cursor-replay-target="runtime-dock"
      {...{ [STUDIO_TARGET_ATTRIBUTE]: STUDIO_KITE_DOCK_TARGET_ID }}
    >
      <div className="flex items-center border-b border-[#11151d] bg-[#1e2129] px-2">
        {KITE_DOCK_TABS.map((tab) => {
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
                {toolLabel}
              </p>
              {isToolActive ? (
                <span
                  aria-label={isFormatting ? "main.kite is formatting" : "Program is running"}
                  className="inline-block size-2.5 shrink-0 animate-spin rounded-full border-2 border-[#d48a37] border-t-transparent"
                />
              ) : null}
            </div>
            <div className="ml-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  clearRunnerConsole(runtimePanelStore, KITE_CONSOLE_SCROLL_SURFACE);
                }}
                disabled={isPlaybackSnapshotActive || effectiveConsoleLines.length === 0}
                className="rounded-md px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-slate-400 transition-colors hover:bg-[#222831] hover:text-white disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent disabled:hover:text-slate-600"
                title="Clear the console"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleFormat();
                }}
                disabled={isPlaybackSnapshotActive || !canFormatWorkspace}
                className="rounded-md bg-[#222d3b] px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] hover:text-[#b5d5ff] disabled:cursor-not-allowed disabled:bg-[#1d232c] disabled:text-[#5c6a7c]"
                title="Format main.kite with kitec fmt (Shift+Alt+F)"
              >
                Format
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
              sessionId={KITE_CONSOLE_SCROLL_SURFACE}
              output={consoleContent}
              interactive={false}
              scrollLine={
                isPlaybackSnapshotActive
                  ? effectiveScrollLines[KITE_CONSOLE_SCROLL_SURFACE]
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

export default KitePlaygroundRunnerPanel;
