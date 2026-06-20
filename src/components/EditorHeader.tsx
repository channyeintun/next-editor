import { memo, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft, PanelRight, RotateCw, Settings } from "lucide-react";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { usePreviewPanel } from "../contexts/PreviewPanelContext";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
} from "../hooks/useWebContainerRuntime";
import { downloadWorkspaceProjectAsZip } from "../utils/workspaceZip";
import {
  importWorkspaceProjectFromZip,
  WorkspaceZipImportError,
} from "../utils/workspaceZipImport";
import {
  useWorkspaceActions,
  useWorkspaceDirtyState,
  useWorkspaceFileCount,
  useWorkspaceLessonType,
  useWorkspaceSidebarCollapsed,
} from "../hooks/useWorkspace";
import { lessonRunsInWebContainer, type WorkspaceLessonType } from "../types/workspace";
import { createStarterWorkspaceForLessonType } from "../starters";
import SlidesButton from "./SlidesButton";

const LESSON_TYPE_OPTIONS: Array<{
  value: WorkspaceLessonType;
  label: string;
}> = [
  { value: "html-css", label: "HTML / CSS" },
  { value: "react", label: "React" },
  { value: "vue", label: "Vue" },
  { value: "solid", label: "Solid" },
  { value: "svelte", label: "Svelte" },
  { value: "htmx-express", label: "HTMX + Express" },
];

const HEADER_TEXT_BUTTON_CLASS =
  "inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-semibold transition-colors";
const HEADER_ICON_BUTTON_CLASS =
  "inline-flex size-8 items-center justify-center rounded-lg border transition-colors";

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
      {lessonRunsInWebContainer(lessonType) ? (
        <button
          type="button"
          onClick={() => {
            void rerunRunner();
          }}
          disabled={!isSupported || !runnerConfig.enabled || isBusy}
          className={`${HEADER_TEXT_BUTTON_CLASS} bg-[#173925] font-bold tracking-[0.04em] text-[#58d88d] uppercase hover:bg-[#1f4a31] hover:text-[#75efa6] disabled:cursor-not-allowed disabled:bg-[#17241e] disabled:text-[#4f8e68]`}
        >
          RUN
        </button>
      ) : null}
    </div>
  );
});

const FileSidebarToggleButton = memo(function FileSidebarToggleButton() {
  const isCollapsed = useWorkspaceSidebarCollapsed();
  const { setSidebarCollapsed } = useWorkspaceActions();
  const isOpen = !isCollapsed;

  return (
    <button
      type="button"
      aria-label={isOpen ? "Hide file explorer" : "Show file explorer"}
      aria-pressed={isOpen}
      title={isOpen ? "Hide file explorer" : "Show file explorer"}
      onClick={() => setSidebarCollapsed(!isCollapsed)}
      className={`${HEADER_ICON_BUTTON_CLASS} ${
        isOpen
          ? "border-[#5da4ff] bg-[#273449] text-white shadow-[0_0_0_1px_rgba(93,164,255,0.22)]"
          : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600 hover:text-white"
      }`}
    >
      <PanelLeft size={16} />
    </button>
  );
});

const PreviewHeaderButton = memo(function PreviewHeaderButton() {
  const { isOpen, openPreview, closePreview } = usePreviewPanel();

  return (
    <button
      type="button"
      aria-label={isOpen ? "Close preview" : "Open preview"}
      aria-pressed={isOpen}
      title={isOpen ? "Close preview" : "Open preview"}
      onClick={() => {
        if (isOpen) {
          closePreview();
          return;
        }

        openPreview();
      }}
      className={`${HEADER_ICON_BUTTON_CLASS} ${
        isOpen
          ? "border-[#5da4ff] bg-[#273449] text-white shadow-[0_0_0_1px_rgba(93,164,255,0.22)]"
          : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600 hover:text-white"
      }`}
    >
      <PanelRight size={16} />
    </button>
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
      className={`${HEADER_TEXT_BUTTON_CLASS} bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50`}
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
      className={`${HEADER_TEXT_BUTTON_CLASS} bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white`}
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
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const { rerunRunner, resetRuntime, updateEnvironmentVariables, updateRunnerConfig } =
    useWebContainerRuntimeActions();
  const { environmentVariables, runnerConfig, status } = useWebContainerRuntimeMetadata();
  const { getProject, loadProject, saveProject } = useWorkspaceActions();
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

  const openImportDialog = () => {
    setIsMenuOpen(false);
    importInputRef.current?.click();
  };

  const handleImportProjectZip = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    // Clear the value so re-selecting the same file fires another change event.
    input.value = "";

    if (!file) {
      return;
    }

    const confirmMessage = hasUnsavedChanges
      ? `Discard the current workspace and unsaved changes? Importing will replace it with "${file.name}".`
      : fileCount > 0
        ? `Discard the current workspace? Importing will replace it with "${file.name}".`
        : `Import "${file.name}"?`;

    if (!window.confirm(confirmMessage)) {
      return;
    }

    let importedProject;
    try {
      importedProject = await importWorkspaceProjectFromZip(file);
    } catch (error) {
      console.error("Project zip import failed:", error);
      window.alert(
        error instanceof WorkspaceZipImportError
          ? error.message
          : "That project could not be imported. Please try a different zip file.",
      );
      return;
    }

    loadProject(importedProject);
    saveProject();
    updateRunnerConfig({ enabled: true });
    // Imported projects ship their own dependencies, so tear the runtime down to
    // force a fresh mount + `npm install` for the new project on next start.
    resetRuntime();
  };

  const handleCreateNewEditor = async () => {
    // "New Editor" starts over within the current framework, so reset to a fresh
    // starter of the active lesson type rather than always falling back to HTML/CSS.
    const currentOption =
      LESSON_TYPE_OPTIONS.find((option) => option.value === lessonType) ?? LESSON_TYPE_OPTIONS[0];
    const confirmMessage = hasUnsavedChanges
      ? `Discard the current workspace and unsaved changes? This will reset the editor to a fresh ${currentOption.label} project.`
      : fileCount > 0
        ? `Discard the current workspace? This will reset the editor to a fresh ${currentOption.label} project.`
        : `Create a new ${currentOption.label} project?`;

    setIsMenuOpen(false);

    if (!window.confirm(confirmMessage)) {
      return;
    }

    // Starter templates are split into per-framework chunks, so fetch the active
    // one on demand before swapping it in.
    const starterProject = await createStarterWorkspaceForLessonType(currentOption.value);

    // Same framework as before, so its dependencies are already installed — just
    // swap the files in (the running dev server picks them up) and keep it running.
    loadProject(starterProject);
    saveProject();
    updateRunnerConfig({ enabled: true });
  };

  const handleSelectLessonType = async (nextLessonType: WorkspaceLessonType) => {
    if (lessonType === nextLessonType) {
      setIsMenuOpen(false);
      return;
    }

    const nextOption = LESSON_TYPE_OPTIONS.find((option) => option.value === nextLessonType);

    if (!nextOption) {
      setIsMenuOpen(false);
      return;
    }

    const nextLessonLabel = `a fresh ${nextOption.label} project`;
    const confirmMessage = hasUnsavedChanges
      ? `Discard the current workspace and unsaved changes? Switching will replace it with ${nextLessonLabel}.`
      : fileCount > 0
        ? `Discard the current workspace? Switching will replace it with ${nextLessonLabel}.`
        : `Switch to ${nextLessonLabel}?`;

    setIsMenuOpen(false);

    if (!window.confirm(confirmMessage)) {
      return;
    }

    // The selected framework's starter lives in its own lazily loaded chunk;
    // pull it in before replacing the workspace.
    const starterProject = await createStarterWorkspaceForLessonType(nextOption.value);

    loadProject(starterProject);
    saveProject();
    updateRunnerConfig({ enabled: true });
    // Each framework ships different dependencies, so tear the runtime down to
    // force a fresh mount + `npm install` for the new project on next start.
    resetRuntime();
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
          className={`${HEADER_ICON_BUTTON_CLASS} border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600 hover:text-white`}
        >
          <Settings size={16} aria-hidden="true" />
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
                    onClick={() => {
                      void handleSelectLessonType(option.value);
                    }}
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
                onClick={() => {
                  void handleCreateNewEditor();
                }}
                className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 hover:text-white"
              >
                New Editor
              </button>

              <div className="my-1 h-px bg-slate-700" />

              {lessonRunsInWebContainer(lessonType) ? (
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
                onClick={openImportDialog}
                className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 hover:text-white"
              >
                Import Project (.zip)
              </button>
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

      <input
        ref={importInputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        className="hidden"
        onChange={(event) => {
          void handleImportProjectZip(event);
        }}
      />

      {isEnvironmentModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-[#0b0d12]/62 px-4 py-8 backdrop-blur-[2px]"
          onClick={closeEnvironmentModal}
        >
          <div
            className="mx-auto flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="space-y-5 overflow-y-auto p-5">
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
                  className="min-h-64 w-full rounded-lg border border-slate-700 bg-[#11141c] font-mono text-sm leading-6 text-slate-100 outline-none transition-colors focus:border-slate-500 p-3"
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
      <div className="flex items-center gap-2">
        <FileSidebarToggleButton />
        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Editor</span>
      </div>
      <div className="flex items-center gap-2">
        <SaveAndRerunControls />
        {showImportExport && (
          <>
            <ImportButton />
            <ExportButton />
            <WorkspaceSettingsButton />
          </>
        )}
        <div className="h-4 w-px bg-slate-700 mx-1" />
        <div className="flex items-center gap-2">
          {showImportExport ? <SlidesButton /> : null}
          <PreviewHeaderButton />
        </div>
      </div>
    </div>
  );
});

export default EditorHeader;
