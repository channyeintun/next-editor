import { useEffect, useEffectEvent, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import { Bot, ChevronDown, ChevronUp, Cog, Maximize2, Minimize2 } from "lucide-react";
import { signInUrl, useAuth } from "@next-editor/infra";
import AgentPanel from "./agent/AgentPanel";
import {
  STUDIO_TARGET_ATTRIBUTE,
  STUDIO_RUN_BUTTON_TARGET_ID,
  STUDIO_ZIG_DOCK_TARGET_ID,
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
import { useZigPlaygroundRunner } from "../hooks/useZigPlaygroundRunner";
import { useWorkspaceActions, useWorkspaceProjectVersion } from "../hooks/useWorkspace";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import { monaco, workspacePathFromMonacoModelUri } from "../monaco";
import {
  zigFormatResultToConsoleLines,
  zigFormatServiceErrorToConsoleLines,
  zigFormatStaleConsoleLines,
  zigFormatStartedConsoleLines,
  zigRunResultToConsoleLines,
  zigRunServiceErrorToConsoleLines,
  zigRunStartedConsoleLines,
} from "../runtime/zigPlayground/console";
import {
  areZigPlaygroundFilesEqual,
  collectZigPlaygroundFiles,
} from "../runtime/zigPlayground/files";
import { appendRunnerConsoleLines } from "../runtime/playgroundConsoleStore";
import type { RuntimeDockTab, RuntimeTerminalScrollLines } from "../types/runtime";
import { areStructuredDataEqual } from "../utils/equality";

/**
 * Focused Run console for Zig lessons — deliberately not a Terminal,
 * mirroring GoPlaygroundRunnerPanel. Code executes remotely through the Zig
 * Playground proxy on an explicit Run or Format action; there is no shell,
 * preview, or WebContainer surface here. The upstream compiles one root
 * source file from a single text body, so lessons run exactly one main.zig. Console output
 * lives in the shared runtime panel store's consoleLines, so the existing
 * runtime recording snapshot captures it and playback replays it without any
 * live execution. The dock also hosts the Agent tab: the agent runs with file
 * tools only in Zig lessons (no bash or runtime observation — see
 * agent/tools/index.ts).
 */

const ZIG_CONSOLE_SCROLL_SURFACE = "zig-runner";

const ANSI_RESET = "\u001b[0m";
const ANSI_DIM = "\u001b[90m";
const ANSI_GREEN = "\u001b[92m";
const ANSI_RED = "\u001b[91m";

// Same prefix-coloring idiom as the other dock consoles: color the [tag], dim
// the rest, leave raw program output undecorated.
function decorateZigConsoleLine(line: string): string {
  const prefixMatch = line.match(/^\[[^\]]+\]/);

  if (!prefixMatch) {
    return line;
  }

  const prefix = prefixMatch[0];
  const suffix = line.slice(prefix.length);
  const prefixColor = prefix.includes("error") ? ANSI_RED : ANSI_GREEN;

  return `${prefixColor}${prefix}${ANSI_RESET}${ANSI_DIM}${suffix}${ANSI_RESET}`;
}

// Zig lessons have no shell or preview, but the agent works on the workspace
// files, so the dock exposes two tabs: the Playground runner and the agent.
const ZIG_DOCK_TABS = [
  {
    id: "runner",
    label: "Zig Runner",
    icon: <Cog size={15} strokeWidth={2.25} />,
  },
  {
    id: "agent",
    label: "Agent",
    icon: <Bot size={14} />,
  },
] as const satisfies readonly { id: RuntimeDockTab; label: string; icon: React.ReactNode }[];

interface ZigRuntimeEventState {
  activeTab: RuntimeDockTab;
  isCollapsed: boolean;
  isFullHeight: boolean;
  consoleLines: string[];
  terminalScrollLines: RuntimeTerminalScrollLines;
}

/** null when the workspace does not contain exactly one Zig file named main.zig. */
function collectSingleZigLessonFile(
  project: Parameters<typeof collectZigPlaygroundFiles>[0],
): ReturnType<typeof collectZigPlaygroundFiles> | null {
  const files = collectZigPlaygroundFiles(project);
  return files.length === 1 && files[0].path === "main.zig" ? files : null;
}

function ZigPlaygroundRunnerPanel() {
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
  const { isRunning, isFormatting, run, format, cancel } = useZigPlaygroundRunner();
  const previousRuntimeEventStateRef = useRef<ZigRuntimeEventState | null>(null);

  // The tab state is shared with the WebContainer dock's store; anything other
  // than "agent" (including a stale "terminal"/"console" from a previous lesson)
  // renders as the Zig Runner tab.
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
    // Zig/project boundaries so output cannot leak into another lesson. A
    // project change also supersedes a Zig tool request started against the
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

  const formatZigProject = async (
    activeModel: monaco.editor.ITextModel | null = null,
  ): Promise<monaco.languages.TextEdit[]> => {
    if (isPlaybackSnapshotActive || isAuthLoading) {
      return [];
    }
    if (!canFormatWorkspace) {
      appendConsoleLines(["[zig-fmt error] This shared lesson is read-only"]);
      return [];
    }
    if (!isSignedIn) {
      appendConsoleLines(zigFormatServiceErrorToConsoleLines("unauthenticated"));
      return [];
    }

    const project = getProject();
    const submittedFiles = collectSingleZigLessonFile(project);
    if (!submittedFiles) {
      appendConsoleLines(["[zig-fmt error] Zig lessons format a single main.zig file"]);
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
      appendConsoleLines(zigFormatStaleConsoleLines());
      return [];
    }

    appendConsoleLines(zigFormatStartedConsoleLines());
    const outcome = await format(submittedFiles);
    if (outcome.kind === "superseded") {
      return [];
    }
    if (outcome.kind === "service-error") {
      appendConsoleLines(zigFormatServiceErrorToConsoleLines(outcome.errorKind, outcome.message));
      return [];
    }

    const currentProject = getProject();
    const currentFiles = collectZigPlaygroundFiles(currentProject);
    if (
      currentProject.id !== project.id ||
      !areZigPlaygroundFilesEqual(currentFiles, submittedFiles) ||
      activeModel?.isDisposed() ||
      (activeModel && activeModel.getVersionId() !== activeModelVersion) ||
      (activeModel && activeModel.getValue() !== submittedActiveFile?.content)
    ) {
      appendConsoleLines(zigFormatStaleConsoleLines());
      return [];
    }

    const formattedFile = outcome.result.files[0];
    const changed = formattedFile.content !== submittedFiles[0].content;

    if (changed && (!activeModel || formattedFile.path !== activePath)) {
      updateFileContent(formattedFile.path, formattedFile.content);
    }
    appendConsoleLines(zigFormatResultToConsoleLines(changed));

    return activeModel && formattedFile.path === activePath && changed
      ? [{ range: activeModel.getFullModelRange(), text: formattedFile.content }]
      : [];
  };

  const provideZigFormattingEdits = useEffectEvent(
    async (
      model: monaco.editor.ITextModel,
      _options: monaco.languages.FormattingOptions,
      token: monaco.CancellationToken,
    ) => {
      if (token.isCancellationRequested) {
        return [];
      }
      return formatZigProject(model);
    },
  );

  useEffect(() => {
    const disposable = monaco.languages.registerDocumentFormattingEditProvider("zig", {
      displayName: "zig fmt (Zig Playground)",
      provideDocumentFormattingEdits: provideZigFormattingEdits,
    });
    return () => disposable.dispose();
  }, [provideZigFormattingEdits]);

  const handleFormat = async () => {
    const editor = editorRef.current;
    if (editor?.getModel()?.getLanguageId() === "zig") {
      const action = editor.getAction("editor.action.formatDocument");
      if (action) {
        await action.run();
        return;
      }
    }
    await formatZigProject();
  };

  const updateScrollLine = (scrollLine: number) => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    const current = runtimePanelStore.getSnapshot().context.terminalScrollLines;
    if (current[ZIG_CONSOLE_SCROLL_SURFACE] === scrollLine) {
      return;
    }

    runtimePanelStore.trigger.setTerminalScrollLines({
      terminalScrollLines: { ...current, [ZIG_CONSOLE_SCROLL_SURFACE]: scrollLine },
    });
  };

  const runtimeEventState: ZigRuntimeEventState = {
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

    // Read the current Zig source at click time — never a stale copy.
    const project = getProject();
    const zigFiles = collectSingleZigLessonFile(project);

    if (!zigFiles) {
      appendConsoleLines(["[zig-run error] Zig lessons run a single main.zig file"]);
      return;
    }

    appendConsoleLines(zigRunStartedConsoleLines());
    const outcome = await run(zigFiles);

    // A newer Run owns the console from here on.
    if (outcome.kind === "superseded") {
      return;
    }

    appendConsoleLines(
      outcome.kind === "result"
        ? zigRunResultToConsoleLines(outcome.result)
        : zigRunServiceErrorToConsoleLines(outcome.errorKind, outcome.message),
    );
  };

  const handleSignIn = async () => {
    // Persist edits before the full-page OAuth navigation so Run-after-sign-in
    // resumes with the same sources.
    await saveProject();
    window.location.assign(signInUrl(`${window.location.pathname}${window.location.search}`));
  };

  const showSignIn = !isPlaybackSnapshotActive && !isAuthLoading && !isSignedIn;
  const consoleContent = effectiveConsoleLines.map(decorateZigConsoleLine).join("\n");
  const dockContentSizeClass =
    displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "h-72";
  const toolLabel = isFormatting ? "zig fmt main.zig" : "zig run main.zig";
  const isToolActive = isRunning || isFormatting;

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-t-md bg-[#15191f] ${
        displayIsFullHeight && !displayIsCollapsed ? "min-h-0 flex-1" : "shrink-0"
      }`}
      data-cursor-replay-target="runtime-dock"
      {...{ [STUDIO_TARGET_ATTRIBUTE]: STUDIO_ZIG_DOCK_TARGET_ID }}
    >
      <div className="flex items-center border-b border-[#11151d] bg-[#1e2129] px-2">
        {ZIG_DOCK_TABS.map((tab) => {
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
                  aria-label={isFormatting ? "main.zig is formatting" : "Program is running"}
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
                  Sign in for Zig tools
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
                    title="Format main.zig with zig fmt (Shift+Alt+F)"
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
              sessionId={ZIG_CONSOLE_SCROLL_SURFACE}
              output={consoleContent}
              interactive={false}
              scrollLine={
                isPlaybackSnapshotActive
                  ? effectiveScrollLines[ZIG_CONSOLE_SCROLL_SURFACE]
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

export default ZigPlaygroundRunnerPanel;
