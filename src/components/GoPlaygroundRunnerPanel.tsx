import { useEffect, useEffectEvent, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import { Bot, ChevronDown, ChevronUp, Diamond, Maximize2, Minimize2 } from "lucide-react";
import { signInUrl, useAuth } from "@next-editor/infra";
import AgentPanel from "./agent/AgentPanel";
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
import { useGoPlaygroundRunner } from "../hooks/useGoPlaygroundRunner";
import { useWorkspaceActions, useWorkspaceProjectVersion } from "../hooks/useWorkspace";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import { monaco, workspacePathFromMonacoModelUri } from "../monaco";
import {
  goFormatResultToConsoleLines,
  goFormatServiceErrorToConsoleLines,
  goFormatStaleConsoleLines,
  goFormatStartedConsoleLines,
  goRunResultToConsoleLines,
  goRunServiceErrorToConsoleLines,
  goRunStartedConsoleLines,
} from "../runtime/goPlayground/console";
import { areGoPlaygroundFilesEqual, collectGoPlaygroundFiles } from "../runtime/goPlayground/files";
import { appendRunnerConsoleLines, clearRunnerConsole } from "../runtime/playgroundConsoleStore";
import {
  STUDIO_TARGET_ATTRIBUTE,
  STUDIO_RUN_BUTTON_TARGET_ID,
  STUDIO_GO_DOCK_TARGET_ID,
} from "../studio/targets";
import type { RuntimeDockTab, RuntimeTerminalScrollLines } from "../types/runtime";
import { areStructuredDataEqual } from "../utils/equality";

/**
 * Focused Run console for Go lessons — deliberately not a Terminal. Code
 * executes remotely through the Go Playground proxy on an explicit Run
 * action; there is no shell, preview, or WebContainer surface here. Console
 * output lives in the shared runtime panel store's consoleLines, so the
 * existing runtime recording snapshot captures it and playback replays it
 * without any live execution. The dock also hosts the Agent tab: the agent
 * runs with file tools only in Go lessons (no bash or runtime observation —
 * see agent/tools/index.ts).
 */

const GO_CONSOLE_SCROLL_SURFACE = "go-runner";

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

// Go lessons have no shell or preview, but the agent works on the workspace
// files, so the dock exposes two tabs: the Playground runner and the agent.
const GO_DOCK_TABS = [
  {
    id: "runner",
    label: "Go Runner",
    icon: <Diamond size={15} strokeWidth={2.25} />,
  },
  {
    id: "agent",
    label: "Agent",
    icon: <Bot size={14} />,
  },
] as const satisfies readonly { id: RuntimeDockTab; label: string; icon: React.ReactNode }[];

interface GoRuntimeEventState {
  activeTab: RuntimeDockTab;
  isCollapsed: boolean;
  isFullHeight: boolean;
  consoleLines: string[];
  terminalScrollLines: RuntimeTerminalScrollLines;
}

function GoPlaygroundRunnerPanel() {
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
  const { getProject, saveProject, updateFileContent } = useWorkspaceActions();
  const projectVersion = useWorkspaceProjectVersion();
  const { isSignedIn, isLoading: isAuthLoading } = useAuth();
  const collaboration = useOptionalCollaboration();
  const { isRunning, isFormatting, run, format, cancel } = useGoPlaygroundRunner();
  const previousRuntimeEventStateRef = useRef<GoRuntimeEventState | null>(null);

  // The tab state is shared with the WebContainer dock's store; anything other
  // than "agent" (including a stale "terminal"/"console" from a previous lesson)
  // renders as the Go Runner tab.
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
    // The runtime panel store is shared by the browser and Go runners. Clear
    // their content-specific console/scroll state at Go/project boundaries so
    // output cannot leak into another lesson. A project change also supersedes
    // a Go tool request started against the previous set of files.
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

  const formatGoProject = async (
    activeModel: monaco.editor.ITextModel | null = null,
  ): Promise<monaco.languages.TextEdit[]> => {
    if (isPlaybackSnapshotActive || isAuthLoading) {
      return [];
    }
    if (!canFormatWorkspace) {
      appendConsoleLines(["[gofmt error] This shared lesson is read-only"]);
      return [];
    }
    if (!isSignedIn) {
      appendConsoleLines(goFormatServiceErrorToConsoleLines("unauthenticated"));
      return [];
    }

    const project = getProject();
    const submittedFiles = collectGoPlaygroundFiles(project);
    if (submittedFiles.length === 0) {
      appendConsoleLines(["[gofmt error] Add at least one .go file to format this lesson"]);
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
      appendConsoleLines(goFormatStaleConsoleLines());
      return [];
    }

    appendConsoleLines(goFormatStartedConsoleLines(submittedFiles.map((file) => file.path)));
    const outcome = await format(submittedFiles);
    if (outcome.kind === "superseded") {
      return [];
    }
    if (outcome.kind === "service-error") {
      appendConsoleLines(goFormatServiceErrorToConsoleLines(outcome.errorKind, outcome.message));
      return [];
    }

    const currentProject = getProject();
    const currentFiles = collectGoPlaygroundFiles(currentProject);
    if (
      currentProject.id !== project.id ||
      !areGoPlaygroundFilesEqual(currentFiles, submittedFiles) ||
      activeModel?.isDisposed() ||
      (activeModel && activeModel.getVersionId() !== activeModelVersion) ||
      (activeModel && activeModel.getValue() !== submittedActiveFile?.content)
    ) {
      appendConsoleLines(goFormatStaleConsoleLines());
      return [];
    }

    const submittedContent = new Map(submittedFiles.map((file) => [file.path, file.content]));
    const changedFiles = outcome.result.files.filter(
      (file) => submittedContent.get(file.path) !== file.content,
    );

    for (const file of changedFiles) {
      if (!activeModel || file.path !== activePath) {
        updateFileContent(file.path, file.content);
      }
    }
    appendConsoleLines(goFormatResultToConsoleLines(changedFiles.map((file) => file.path)));

    const formattedActiveFile = activePath
      ? outcome.result.files.find((file) => file.path === activePath)
      : null;
    return activeModel &&
      formattedActiveFile &&
      formattedActiveFile.content !== submittedActiveFile?.content
      ? [{ range: activeModel.getFullModelRange(), text: formattedActiveFile.content }]
      : [];
  };

  const provideGoFormattingEdits = useEffectEvent(
    async (
      model: monaco.editor.ITextModel,
      _options: monaco.languages.FormattingOptions,
      token: monaco.CancellationToken,
    ) => {
      if (token.isCancellationRequested) {
        return [];
      }
      return formatGoProject(model);
    },
  );

  useEffect(() => {
    const disposable = monaco.languages.registerDocumentFormattingEditProvider("go", {
      displayName: "gofmt (Go Playground)",
      provideDocumentFormattingEdits: provideGoFormattingEdits,
    });
    return () => disposable.dispose();
  }, [provideGoFormattingEdits]);

  const handleFormat = async () => {
    const editor = editorRef.current;
    if (editor?.getModel()?.getLanguageId() === "go") {
      const action = editor.getAction("editor.action.formatDocument");
      if (action) {
        await action.run();
        return;
      }
    }
    await formatGoProject();
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

    // Read every current Go source file at click time — never a stale copy.
    const project = getProject();
    const goFiles = collectGoPlaygroundFiles(project);

    if (goFiles.length === 0) {
      appendConsoleLines(["[go-run error] Add at least one .go file to run this lesson"]);
      return;
    }

    appendConsoleLines(goRunStartedConsoleLines(goFiles.map((file) => file.path)));
    const outcome = await run(goFiles);

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
    // resumes with the same sources.
    await saveProject();
    window.location.assign(signInUrl(`${window.location.pathname}${window.location.search}`));
  };

  const showSignIn = !isPlaybackSnapshotActive && !isAuthLoading && !isSignedIn;
  const consoleContent = effectiveConsoleLines.map(decorateGoConsoleLine).join("\n");
  const dockContentSizeClass =
    displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "h-72";
  const toolLabel = isFormatting ? "gofmt *.go" : "go run *.go";
  const isToolActive = isRunning || isFormatting;

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-t-md bg-[#15191f] ${
        displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "shrink-0"
      }`}
      data-cursor-replay-target="runtime-dock"
      {...{ [STUDIO_TARGET_ATTRIBUTE]: STUDIO_GO_DOCK_TARGET_ID }}
    >
      <div className="flex items-center border-b border-[#11151d] bg-[#1e2129] px-2">
        {GO_DOCK_TABS.map((tab) => {
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
                  aria-label={isFormatting ? "Go files are formatting" : "Program is running"}
                  className="inline-block size-2.5 shrink-0 animate-spin rounded-full border-2 border-[#d48a37] border-t-transparent"
                />
              ) : null}
            </div>
            <div className="ml-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  clearRunnerConsole(runtimePanelStore, GO_CONSOLE_SCROLL_SURFACE);
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
                  Sign in for Go tools
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void handleFormat();
                    }}
                    disabled={isPlaybackSnapshotActive || isAuthLoading || !canFormatWorkspace}
                    className="rounded-md bg-[#222d3b] px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] hover:text-[#b5d5ff] disabled:cursor-not-allowed disabled:bg-[#1d232c] disabled:text-[#5c6a7c]"
                    title="Format every Go file with gofmt (Shift+Alt+F)"
                  >
                    Format
                  </button>
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
                </>
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
