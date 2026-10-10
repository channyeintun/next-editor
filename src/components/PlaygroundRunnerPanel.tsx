import { useEffect, useEffectEvent, useState } from "react";
import { useSelector } from "@xstate/store-react";
import { Bot } from "lucide-react";
import AgentPanel from "./agent/AgentPanel";
import XtermTerminal from "./XtermTerminal";
import RuntimeDockHeader, { type RuntimeDockTabConfig } from "./terminalPanel/RuntimeDockHeader";
import {
  ANSI,
  colorizeTaggedLine,
  dockContentSizeClassName,
  dockRootSizeClassName,
} from "./terminalPanel/runtimeDockHelpers";
import { useRuntimeDockRecording } from "./terminalPanel/useRuntimeDockRecording";
import type { PlaygroundConsoleTags, PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import {
  selectConsoleLines,
  selectTerminalScrollLines,
  setTerminalScrollLineIfChanged,
} from "../stores/runtimePanelStore";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { usePlaygroundRunner } from "../hooks/usePlaygroundRunner";
import { useRuntimeDockLayout } from "../hooks/useRuntimeDockLayout";
import { useWorkspaceActions, useWorkspaceProjectVersion } from "../hooks/useWorkspace";
import { monaco, workspacePathFromMonacoModelUri } from "../monaco";
import {
  appendRunnerConsoleLines,
  beginRunnerOperation,
  clearRunnerConsole,
  resetRunnerConsoleForProject,
} from "../runtime/playgroundConsoleStore";
import { arePlaygroundFilesEqual } from "../runtime/playgroundFiles";
import {
  STUDIO_DOCK_TOGGLE_TARGET_ID,
  STUDIO_TARGET_ATTRIBUTE,
  STUDIO_RUN_BUTTON_TARGET_ID,
} from "../studio/targets";
import type { RuntimeDockTab, RuntimeTerminalScrollLines } from "../types/runtime";

/**
 * Focused Run console for Playground lessons — deliberately not a Terminal.
 * Code executes on an explicit Run or Format action, remotely through a
 * Playground proxy or in the page, as the language says; there is no shell,
 * preview, or WebContainer surface here. Console output lives in the shared
 * runtime panel store's consoleLines, so the existing runtime recording
 * snapshot captures it and playback replays it without any live execution.
 * The dock also hosts the Agent tab: the agent runs with file tools only in
 * Playground lessons (no bash or runtime observation — see
 * agent/tools/index.ts).
 *
 * Each language renders this from its own component with its own
 * PlaygroundRunnerLanguage, so switching language remounts the panel and the
 * runner never reuses another language's client.
 */

// Same prefix-coloring idiom as the WebContainer dock's console: color the
// [tag], dim the rest, leave raw program output undecorated. Only the tags the
// language's console module emits match, so a program's own bracketed line — a
// printed list, say — is left alone.
function decorateConsoleLine(line: string, tags: PlaygroundConsoleTags): string {
  return colorizeTaggedLine(line, tags.pattern, (prefix) =>
    prefix.includes("error")
      ? ANSI.red
      : tags.warningPrefix && prefix.startsWith(tags.warningPrefix)
        ? ANSI.yellow
        : ANSI.green,
  );
}

// What the status region says once Run or Format has finished: the first error
// line, which names the failure ahead of any diagnostics or detail after it,
// or else the last line ("Program exited", "Formatted main.go"), without its tag.
function describeOutcome(lines: readonly string[], tags: PlaygroundConsoleTags): string {
  const summary =
    lines.find((line) => line.match(tags.pattern)?.[0].includes("error")) ?? lines.at(-1) ?? "";
  return summary.replace(tags.pattern, "").trim();
}

interface RuntimeEventState {
  activeTab: RuntimeDockTab;
  isCollapsed: boolean;
  isFullHeight: boolean;
  consoleLines: string[];
  terminalScrollLines: RuntimeTerminalScrollLines;
}

function PlaygroundRunnerPanel<Client, ErrorKind extends string, RunResult>({
  language,
}: {
  language: PlaygroundRunnerLanguage<Client, ErrorKind, RunResult>;
}) {
  const { scrollSurface, dockTargetId, runnerTab, consoleTags, collectFiles, run, format } =
    language;
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const layout = useRuntimeDockLayout();
  const {
    activeTab,
    isCollapsed,
    isFullHeight,
    recordedRuntimeSnapshot,
    isPlaybackSnapshotActive,
    displayActiveTab: rawActiveTab,
    displayIsCollapsed,
    fillsColumn,
  } = layout;
  const consoleLines = useSelector(runtimePanelStore, (s) => selectConsoleLines(s.context));
  const terminalScrollLines = useSelector(runtimePanelStore, (s) =>
    selectTerminalScrollLines(s.context),
  );
  const { editorRef, handleRuntimeEvent } = useNextEditorActions();
  const { currentRecording, isRecording } = useNextEditorMetadata();
  const { getProject, updateFileContent } = useWorkspaceActions();
  const projectVersion = useWorkspaceProjectVersion();
  const collaboration = useOptionalCollaboration();
  const { activeOperation, request, cancel } = usePlaygroundRunner<
    Client,
    "run" | "format",
    ErrorKind
  >(language.client);
  const isRunning = activeOperation === "run";
  const isFormatting = activeOperation === "format";
  // The finished Run or Format, for the status region; the busy text replaces it.
  const [outcomeText, setOutcomeText] = useState("");

  // The tab state is shared with the WebContainer dock's store; anything other
  // than "agent" (including a stale "terminal"/"console" from a previous lesson)
  // renders as the runner tab.
  const displayActiveTab: RuntimeDockTab = rawActiveTab === "agent" ? "agent" : "runner";
  const canFormatWorkspace = !collaboration?.provider || collaboration.canWrite;
  const effectiveConsoleLines = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.consoleLines ?? [])
    : consoleLines;
  const effectiveScrollLines = isPlaybackSnapshotActive
    ? (recordedRuntimeSnapshot?.terminalScrollLines ?? {})
    : terminalScrollLines;

  useEffect(() => {
    // The runtime panel store is shared by the browser and playground
    // runners. Clear their content-specific console/scroll state at
    // language/project boundaries so output cannot leak into another lesson. A
    // project change also supersedes a tool request started against the
    // previous set of files.
    cancel();

    resetRunnerConsoleForProject(runtimePanelStore);
    return () => resetRunnerConsoleForProject(runtimePanelStore);
  }, [cancel, projectVersion, runtimePanelStore]);

  useEffect(() => {
    if (isPlaybackSnapshotActive) {
      cancel();
    }
  }, [cancel, isPlaybackSnapshotActive]);

  // Prints how a Run or Format ended, refusals included, and says it in the
  // status region.
  const appendOutcomeLines = (lines: string[]) => {
    appendRunnerConsoleLines(runtimePanelStore, lines);
    setOutcomeText(describeOutcome(lines, consoleTags));
  };

  const formatProject = async (
    activeModel: monaco.editor.ITextModel | null = null,
  ): Promise<monaco.languages.TextEdit[]> => {
    if (!format || isPlaybackSnapshotActive) {
      return [];
    }
    if (!canFormatWorkspace) {
      appendOutcomeLines([format.readOnlyLine]);
      return [];
    }

    const project = getProject();
    const submittedFiles = collectFiles(project);
    const rejection = format.rejectFiles(submittedFiles);
    if (rejection) {
      appendOutcomeLines([rejection]);
      return [];
    }

    const activePath = activeModel ? workspacePathFromMonacoModelUri(activeModel.uri) : null;
    const activeModelVersion = activeModel?.getVersionId();
    const submittedActiveFile = activePath
      ? submittedFiles.find((file) => file.path === activePath)
      : null;
    if (activeModel && !submittedActiveFile && format.unsubmittedModelLine) {
      appendOutcomeLines([format.unsubmittedModelLine]);
      return [];
    }
    if (
      activeModel &&
      (!submittedActiveFile || activeModel.getValue() !== submittedActiveFile.content)
    ) {
      appendOutcomeLines(format.staleLines());
      return [];
    }

    setOutcomeText("");
    beginRunnerOperation(runtimePanelStore, format.startedLines(submittedFiles));
    const outcome = await request("format", (client) => format.execute(client, submittedFiles));
    if (outcome.kind === "superseded") {
      return [];
    }
    if (outcome.kind === "service-error") {
      appendOutcomeLines(format.serviceErrorLines(outcome.errorKind, outcome.message));
      return [];
    }

    const currentProject = getProject();
    const currentFiles = collectFiles(currentProject);
    if (
      currentProject.id !== project.id ||
      !arePlaygroundFilesEqual(currentFiles, submittedFiles) ||
      activeModel?.isDisposed() ||
      (activeModel && activeModel.getVersionId() !== activeModelVersion) ||
      (activeModel && activeModel.getValue() !== submittedActiveFile?.content)
    ) {
      appendOutcomeLines(format.staleLines());
      return [];
    }

    // A format can touch several files: every Go file, or every file of a Kite
    // module, which is a directory. A client answers with exactly the files it
    // was sent. Every changed file except the open one is written straight to
    // the workspace; the open one comes back as an edit so Monaco keeps the
    // undo stack.
    const submittedContent = new Map(submittedFiles.map((file) => [file.path, file.content]));
    const changedFiles = outcome.result.files.filter(
      (file) => submittedContent.get(file.path) !== file.content,
    );

    for (const file of changedFiles) {
      if (!activeModel || file.path !== activePath) {
        updateFileContent(file.path, file.content);
      }
    }
    appendOutcomeLines(format.resultLines(changedFiles.map((file) => file.path)));

    const formattedActiveFile = activePath
      ? outcome.result.files.find((file) => file.path === activePath)
      : null;
    return activeModel &&
      formattedActiveFile &&
      formattedActiveFile.content !== submittedActiveFile?.content
      ? [{ range: activeModel.getFullModelRange(), text: formattedActiveFile.content }]
      : [];
  };

  const provideFormattingEdits = useEffectEvent(
    async (
      model: monaco.editor.ITextModel,
      _options: monaco.languages.FormattingOptions,
      token: monaco.CancellationToken,
    ) => {
      if (token.isCancellationRequested) {
        return [];
      }
      return formatProject(model);
    },
  );

  // One registration per mount. The effect event is called from the closure
  // rather than listed as a dependency: React 19.3 returns a new function for
  // it on every render (see CodeEditor's syncActivePlaybackModel effect), which
  // would re-register the provider on every console line.
  useEffect(() => {
    if (!format) {
      return;
    }
    const disposable = monaco.languages.registerDocumentFormattingEditProvider(
      format.monacoLanguageId,
      {
        displayName: format.providerDisplayName,
        provideDocumentFormattingEdits: (model, options, token) =>
          provideFormattingEdits(model, options, token),
      },
    );
    return () => disposable.dispose();
  }, [format]);

  const handleFormat = async () => {
    const editor = editorRef.current;
    if (format && editor?.getModel()?.getLanguageId() === format.monacoLanguageId) {
      const action = editor.getAction("editor.action.formatDocument");
      if (action) {
        await action.run();
        return;
      }
    }
    await formatProject();
  };

  const updateScrollLine = (scrollLine: number) => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    setTerminalScrollLineIfChanged(runtimePanelStore, scrollSurface, scrollLine);
  };

  const runtimeEventState: RuntimeEventState = {
    activeTab,
    isCollapsed,
    isFullHeight,
    consoleLines,
    terminalScrollLines,
  };

  useRuntimeDockRecording(runtimeEventState, {
    isRecording,
    isPlaybackSnapshotActive,
    currentRecording,
    handleRuntimeEvent,
    runtimePanelStore,
  });

  const handleRun = async () => {
    if (isPlaybackSnapshotActive) {
      return;
    }

    // Read every current source file at click time — never a stale copy.
    const project = getProject();
    const files = collectFiles(project);
    const rejection = run.rejectFiles?.(files);
    if (rejection) {
      appendOutcomeLines([rejection]);
      return;
    }

    setOutcomeText("");
    beginRunnerOperation(runtimePanelStore, run.startedLines(files));
    const outcome = await request("run", (client) => run.execute(client, files));

    // A newer Run owns the console from here on.
    if (outcome.kind === "superseded") {
      return;
    }

    appendOutcomeLines(
      outcome.kind === "result"
        ? run.resultLines(outcome.result)
        : run.serviceErrorLines(outcome.errorKind, outcome.message),
    );
  };

  const consoleContent = effectiveConsoleLines
    .map((line) => decorateConsoleLine(line, consoleTags))
    .join("\n");
  const dockContentSizeClass = dockContentSizeClassName(fillsColumn);
  const toolLabel = format && isFormatting ? format.commandLabel : run.commandLabel;
  const RunnerIcon = runnerTab.icon;
  // Playground lessons have no shell or preview, but the agent works on the
  // workspace files, so the dock exposes two tabs: the runner and the agent.
  const dockTabs = [
    {
      id: "runner",
      label: runnerTab.label,
      icon: <RunnerIcon size={15} strokeWidth={2.25} />,
    },
    {
      id: "agent",
      label: "Agent",
      icon: <Bot size={14} />,
    },
  ] as const satisfies readonly RuntimeDockTabConfig[];

  const runButton = (
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
  );

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-t-md bg-[#15191f] ${dockRootSizeClassName(
        fillsColumn,
      )}`}
      data-cursor-replay-target="runtime-dock"
      {...{ [STUDIO_TARGET_ATTRIBUTE]: dockTargetId }}
    >
      {/* Unlike the WebContainer dock's, this collapse toggle carries no
          data-tour="runner": the tour's Runner step describes the terminal and
          dev-server output, which a Playground lesson does not have. */}
      <RuntimeDockHeader
        tabs={dockTabs}
        activeTab={displayActiveTab}
        disabled={isPlaybackSnapshotActive}
        onSelectTab={(tab) => runtimePanelStore.trigger.setActiveTab({ tab })}
        layout={layout}
        collapseToggleAttributes={{ [STUDIO_TARGET_ATTRIBUTE]: STUDIO_DOCK_TOGGLE_TARGET_ID }}
      />

      {!displayIsCollapsed && displayActiveTab === "agent" && (
        <AgentPanel isFullHeight={fillsColumn} />
      )}

      {!displayIsCollapsed && displayActiveTab === "runner" && (
        <div className={`flex ${dockContentSizeClass} flex-col bg-[#15191f]`}>
          <div className="flex min-h-15.5 items-center justify-between border-b border-[#11151d] bg-[#191d25] px-4 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <p className="truncate font-mono text-[13px] font-semibold text-slate-300">
                {toolLabel}
              </p>
              {isRunning || isFormatting ? (
                <span
                  aria-hidden="true"
                  className="inline-block size-2.5 shrink-0 animate-spin rounded-full border-2 border-[#d48a37] border-t-transparent"
                />
              ) : null}
            </div>
            <div className="ml-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  clearRunnerConsole(runtimePanelStore, scrollSurface);
                }}
                disabled={isPlaybackSnapshotActive || effectiveConsoleLines.length === 0}
                className="rounded-md px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-slate-300 transition-colors hover:bg-[#222831] hover:text-white disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:bg-transparent disabled:hover:text-slate-600"
                title="Clear the console"
              >
                Clear
              </button>
              {format ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      void handleFormat();
                    }}
                    disabled={isPlaybackSnapshotActive || !canFormatWorkspace}
                    className="rounded-md bg-[#222d3b] px-3 py-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-[#b5d5ff] transition-colors hover:bg-[#2a3a4d] hover:text-white disabled:cursor-not-allowed disabled:bg-[#1d232c] disabled:text-[#5c6a7c]"
                    title={format.buttonTitle}
                  >
                    Format
                  </button>
                  {runButton}
                </>
              ) : (
                runButton
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden px-5 py-6 bg-[#15191f]">
            <XtermTerminal
              sessionId={scrollSurface}
              output={consoleContent}
              interactive={false}
              label={`${runnerTab.label} output`}
              scrollLine={
                isPlaybackSnapshotActive ? effectiveScrollLines[scrollSurface] : undefined
              }
              onScroll={updateScrollLine}
            />
          </div>
        </div>
      )}

      {/* Mounted with the dock rather than the runner tab, so a Format started
          from the editor, or a Run that ends after a switch to the Agent tab, is
          still announced, and a tab switch never re-announces an old result. */}
      <span role="status" className="sr-only">
        {format && isFormatting ? format.busyLabel : isRunning ? "Program is running" : outcomeText}
      </span>
    </div>
  );
}

export default PlaygroundRunnerPanel;
