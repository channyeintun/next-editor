import { useEffect, useEffectEvent } from "react";
import type { PlaygroundRequestOutcome } from "../../hooks/usePlaygroundRunner";
import { useNextEditorActions } from "../../hooks/useNextEditorContext";
import { useWorkspaceActions } from "../../hooks/useWorkspace";
import { monaco, workspacePathFromMonacoModelUri } from "../../monaco";
import { beginRunnerOperation } from "../../runtime/playgroundConsoleStore";
import { arePlaygroundFilesEqual, type PlaygroundFile } from "../../runtime/playgroundFiles";
import type { PlaygroundLanguage } from "../../runtime/playgroundLanguage";
import type { RuntimePanelStoreInstance } from "../../stores/runtimePanelStore";

type FormatResult = { files: readonly PlaygroundFile[] };

interface PlaygroundFormattingOptions<Client, ErrorKind extends string> {
  /** The dock's runner request, so a Format supersedes a Run and the other way round. */
  request: (
    operation: "format",
    execute: (client: Client) => Promise<FormatResult>,
  ) => Promise<PlaygroundRequestOutcome<FormatResult, ErrorKind>>;
  isPlaybackSnapshotActive: boolean;
  /** False in a shared lesson this viewer cannot edit: Format prints its read-only line. */
  canFormatWorkspace: boolean;
  runtimePanelStore: RuntimePanelStoreInstance;
  /** Prints how the Format ended and says it in the dock's status region. */
  appendOutcomeLines: (lines: string[]) => void;
  setOutcomeText: (text: string) => void;
}

/**
 * The runner dock's Format flow: the Format button, and the Monaco document
 * formatting provider the editor's own Format Document command reaches. Both
 * submit every source the language collects, then write the result back only
 * if nothing changed while the formatter ran; the open file comes back as a
 * Monaco edit so the editor keeps its undo stack. A language with no formatter
 * registers no provider, and its Format does nothing.
 */
export function usePlaygroundFormatting<Client, ErrorKind extends string>(
  {
    collectFiles,
    format,
  }: Pick<PlaygroundLanguage<Client, ErrorKind, unknown>, "collectFiles" | "format">,
  {
    request,
    isPlaybackSnapshotActive,
    canFormatWorkspace,
    runtimePanelStore,
    appendOutcomeLines,
    setOutcomeText,
  }: PlaygroundFormattingOptions<Client, ErrorKind>,
): { handleFormat: () => Promise<void> } {
  const { editorRef } = useNextEditorActions();
  const { getProject, updateFileContent } = useWorkspaceActions();

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

  // The button goes through Monaco's Format Document when the open file is the
  // formatter's language, so the edit lands with the editor's undo stack;
  // otherwise it formats the workspace directly.
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

  return { handleFormat };
}
