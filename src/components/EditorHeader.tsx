import { memo, useEffect, useMemo, useState } from "react";
import { RotateCw } from "lucide-react";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
} from "../hooks/useWebContainerRuntime";
import { downloadWorkspaceProjectAsZip } from "../utils/workspaceZip";
import {
  useWorkspaceActions,
  useWorkspaceDirtyState,
  useWorkspaceFileCount,
  useWorkspaceLessonType,
} from "../hooks/useWorkspace";
import type { WorkspaceLessonType } from "../types/workspace";
import SettingIcon from "./icon/Setting";
import SlidesButton from "./SlidesButton";

const LESSON_TYPE_OPTIONS: Array<{
  value: WorkspaceLessonType;
  label: string;
}> = [
  {
    value: "node.js",
    label: "Node.js Lesson",
  },
  {
    value: "html-css",
    label: "HTML/CSS Lesson",
  },
];

function isAppleUserAgent(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const userAgentDataPlatform = navigatorWithUserAgentData.userAgentData?.platform;
  const platform = userAgentDataPlatform ?? navigator.platform ?? "";
  const userAgent = navigator.userAgent ?? "";

  return /Mac|iPhone|iPad|iPod/i.test(`${platform} ${userAgent}`);
}

function getSaveShortcutLabel(): string {
  return isAppleUserAgent() ? "CMD + S" : "CTRL + S";
}

function stringifyEnvironmentVariables(variables: Record<string, string>): string {
  return Object.entries(variables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseEnvironmentInput(value: string): {
  environmentVariables: Record<string, string>;
  errorMessage: string | null;
} {
  const environmentVariables: Record<string, string> = {};
  const lines = value.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex <= 0) {
      return {
        environmentVariables: {},
        errorMessage: `Line ${index + 1} must use KEY=value format.`,
      };
    }

    const key = line.slice(0, separatorIndex).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return {
        environmentVariables: {},
        errorMessage: `Line ${index + 1} has an invalid variable name.`,
      };
    }

    environmentVariables[key] = line.slice(separatorIndex + 1);
  }

  return {
    environmentVariables,
    errorMessage: null,
  };
}

const SaveAndRerunControls = memo(function SaveAndRerunControls() {
  const { rerunRunner } = useWebContainerRuntimeActions();
  const { isSupported, runnerConfig, status } = useWebContainerRuntimeMetadata();
  const lessonType = useWorkspaceLessonType();
  const saveShortcutLabel = useMemo(() => getSaveShortcutLabel(), []);
  const isBusy =
    status === "booting" ||
    status === "mounting" ||
    status === "installing" ||
    status === "starting";

  return (
    <div className="flex items-center gap-3">
      <span
        className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500"
        title="Save all and refresh"
      >
        {saveShortcutLabel}
        <RotateCw size={11} strokeWidth={2.25} aria-hidden="true" />
      </span>
      {lessonType === "node.js" ? (
        <button
          type="button"
          onClick={() => {
            void rerunRunner();
          }}
          disabled={!isSupported || !runnerConfig.enabled || isBusy}
          className="px-3 py-1 text-xs text-emerald-300 hover:text-emerald-200 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors font-semibold"
        >
          RERUN
        </button>
      ) : null}
    </div>
  );
});

const ExportButton = memo(function ExportButton() {
  const { exportAsFile } = useNextEditorActions();
  const { currentRecording } = useNextEditorMetadata();

  const handleExport = async () => {
    if (currentRecording) {
      try {
        await exportAsFile(currentRecording);
      } catch (error) {
        console.error("Export failed:", error);
      }
    }
  };

  return (
    <button
      onClick={handleExport}
      disabled={!currentRecording}
      className="px-3 py-1 text-xs text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
    >
      Export
    </button>
  );
});

const ImportButton = memo(function ImportButton() {
  const { importFromFile, loadRecording } = useNextEditorActions();

  const handleImport = async () => {
    try {
      const importedRecordings = await importFromFile();
      if (importedRecordings.length > 0) {
        loadRecording(importedRecordings[0]);
      }
    } catch (error) {
      console.error("Import failed:", error);
    }
  };

  return (
    <button
      onClick={handleImport}
      className="px-3 py-1 text-xs text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded transition-colors"
    >
      Import
    </button>
  );
});

const WorkspaceSettingsButton = memo(function WorkspaceSettingsButton() {
  const [draftValue, setDraftValue] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isEnvironmentModalOpen, setIsEnvironmentModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { rerunRunner, updateEnvironmentVariables, updateRunnerConfig } =
    useWebContainerRuntimeActions();
  const { environmentVariables, runnerConfig, status } = useWebContainerRuntimeMetadata();
  const { createNewEditor, getProject, resetProject, saveProject } = useWorkspaceActions();
  const fileCount = useWorkspaceFileCount();
  const lessonType = useWorkspaceLessonType();
  const { hasUnsavedChanges } = useWorkspaceDirtyState();

  const isBusy =
    status === "booting" ||
    status === "mounting" ||
    status === "installing" ||
    status === "starting";

  useEffect(() => {
    if (!isEnvironmentModalOpen) {
      return;
    }

    setDraftValue(stringifyEnvironmentVariables(environmentVariables));
    setErrorMessage(null);
  }, [environmentVariables, isEnvironmentModalOpen]);

  const closeEnvironmentModal = () => {
    setIsEnvironmentModalOpen(false);
    setErrorMessage(null);
  };

  const handleEditEnvironment = () => {
    setIsMenuOpen(false);
    setIsEnvironmentModalOpen(true);
  };

  const handleDownload = async () => {
    setIsMenuOpen(false);

    try {
      await downloadWorkspaceProjectAsZip(getProject());
    } catch (error) {
      console.error("Zip download failed:", error);
    }
  };

  const handleCreateNewEditor = () => {
    const confirmMessage = hasUnsavedChanges
      ? "Discard the current workspace and unsaved changes? This will reset the editor to a fresh index.html file."
      : fileCount > 0
        ? "Discard the current workspace? This will reset the editor to a fresh index.html file."
        : "Create a new editor with a fresh index.html file?";

    setIsMenuOpen(false);

    if (!window.confirm(confirmMessage)) {
      return;
    }

    createNewEditor();
    saveProject();
    updateRunnerConfig({ enabled: false });
  };

  const handleSelectLessonType = (nextLessonType: WorkspaceLessonType) => {
    if (lessonType === nextLessonType) {
      setIsMenuOpen(false);
      return;
    }

    const nextLessonLabel =
      nextLessonType === "node.js" ? "a fresh Node.js lesson" : "a fresh HTML/CSS lesson";
    const confirmMessage = hasUnsavedChanges
      ? `Discard the current workspace and unsaved changes? Switching lesson type will replace it with ${nextLessonLabel}.`
      : fileCount > 0
        ? `Discard the current workspace? Switching lesson type will replace it with ${nextLessonLabel}.`
        : `Switch to ${nextLessonLabel}?`;

    setIsMenuOpen(false);

    if (!window.confirm(confirmMessage)) {
      return;
    }

    if (nextLessonType === "node.js") {
      resetProject();
    } else {
      createNewEditor();
    }

    saveProject();
    updateRunnerConfig({ enabled: nextLessonType === "node.js" });
  };

  const handleSave = () => {
    const parsed = parseEnvironmentInput(draftValue);

    if (parsed.errorMessage) {
      setErrorMessage(parsed.errorMessage);
      return;
    }

    updateEnvironmentVariables(parsed.environmentVariables);
    closeEnvironmentModal();

    if (runnerConfig.enabled && !isBusy) {
      void rerunRunner();
    }
  };

  return (
    <>
      <div className={`relative ${isMenuOpen ? "z-2147483647" : ""}`}>
        <button
          type="button"
          aria-label="Open workspace settings"
          aria-expanded={isMenuOpen}
          aria-haspopup="menu"
          onClick={() => setIsMenuOpen((current) => !current)}
          className="relative z-2147483647 flex items-center justify-center rounded bg-slate-700 text-slate-300 transition-colors hover:bg-slate-600 hover:text-white size-8"
        >
          <SettingIcon />
        </button>

        {isMenuOpen ? (
          <>
            <div className="fixed inset-0 z-2147483646" onClick={() => setIsMenuOpen(false)} />
            <div
              role="menu"
              className="absolute right-0 top-full z-2147483647 mt-2 w-56 rounded-xl border border-slate-700 bg-[#151821] p-1 shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
            >
              {LESSON_TYPE_OPTIONS.map((option) => {
                const isActive = option.value === lessonType;

                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => handleSelectLessonType(option.value)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors ${
                      isActive
                        ? "bg-slate-700 text-white"
                        : "text-slate-200 hover:bg-slate-700 hover:text-white"
                    }`}
                  >
                    <span>{option.label}</span>
                    {isActive ? (
                      <span className="rounded-full bg-slate-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-200">
                        Active
                      </span>
                    ) : null}
                  </button>
                );
              })}

              <div className="my-1 h-px bg-slate-700" />

              <button
                type="button"
                role="menuitem"
                onClick={handleCreateNewEditor}
                className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 hover:text-white"
              >
                New Editor
              </button>

              <div className="my-1 h-px bg-slate-700" />

              {lessonType === "node.js" ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleEditEnvironment}
                  className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 hover:text-white"
                >
                  Edit Environment
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void handleDownload();
                }}
                className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 hover:text-white"
              >
                Download As Zip
              </button>
            </div>
          </>
        ) : null}
      </div>

      {isEnvironmentModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-[#0b0d12]/62 px-4 py-8 backdrop-blur-[2px]"
          onClick={closeEnvironmentModal}
        >
          <div
            className="mx-auto flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="space-y-5 overflow-y-auto px-5 py-5">
              <p className="text-sm font-medium text-slate-100">Edit Environment</p>

              <label className="block">
                <span className="sr-only">Environment variables</span>
                <textarea
                  value={draftValue}
                  onChange={(event) => {
                    setDraftValue(event.target.value);
                    if (errorMessage) {
                      setErrorMessage(null);
                    }
                  }}
                  rows={12}
                  spellCheck={false}
                  className="min-h-64 w-full rounded-lg border border-slate-700 bg-[#11141c] px-3 py-3 font-mono text-sm leading-6 text-slate-100 outline-none transition-colors focus:border-slate-500"
                  placeholder="API_URL=https://example.com\nNODE_ENV=development"
                />
              </label>

              {errorMessage ? <p className="text-sm text-rose-300">{errorMessage}</p> : null}

              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={closeEnvironmentModal}
                  className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-400 transition-colors hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  className="rounded bg-emerald-500 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-950 transition-colors hover:bg-emerald-400"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

interface EditorHeaderProps {
  showImportExport: boolean;
}

const EditorHeader = memo(function EditorHeader({ showImportExport }: EditorHeaderProps) {
  return (
    <div className="bg-[#11141c] px-4 py-1.5 flex items-center justify-between">
      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Editor</span>
      <div className="flex items-center gap-2">
        <SaveAndRerunControls />
        {showImportExport && (
          <>
            <ImportButton />
            <ExportButton />
            <WorkspaceSettingsButton />
            <div className="h-4 w-px bg-slate-700 mx-1" />
            <SlidesButton />
          </>
        )}
      </div>
    </div>
  );
});

export default EditorHeader;
