import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Compass,
  Download,
  FileArchive,
  FileDown,
  FileUp,
  FilePlus2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PenTool,
  Settings,
  Variable,
} from "lucide-react";
import { useNextEditorActions, useNextEditorMetadata } from "../hooks/useNextEditorContext";
import { usePreviewPanel } from "../contexts/PreviewPanelContext";
import { useWhiteboardContext } from "../contexts/WhiteboardContext";
import { useWebContainerRuntimeActions } from "../hooks/useWebContainerRuntime";
import { analytics } from "../utils/analytics";
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
  useWorkspaceSaveStatus,
  useWorkspaceSidebarCollapsed,
} from "../hooks/useWorkspace";
import {
  lessonRunsInWebContainer,
  lessonSupportsPreview,
  WORKSPACE_LESSON_TYPE_LABELS,
  WORKSPACE_LESSON_TYPES,
  type WorkspaceLessonType,
} from "../types/workspace";
import { createStarterWorkspaceForLessonType } from "../starters";
import SlidesButton from "./SlidesButton";
import CollaborationPanel from "./CollaborationPanel";
import EnvironmentVariablesDialog from "./editorHeader/EnvironmentVariablesDialog";
import SettingsMenuItem from "./editorHeader/SettingsMenuItem";
import StarterTemplateSubmenu, {
  type LessonTypeOption,
} from "./editorHeader/StarterTemplateSubmenu";
import { startTour } from "./tour/productTour";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import { useSlidesContext } from "../contexts/SlidesContext";
import { discardRecordingDraftFor } from "../storage/recordingDrafts/recordingDraftJournal";

const LESSON_TYPE_OPTIONS: LessonTypeOption[] = WORKSPACE_LESSON_TYPES.map((value) => ({
  value,
  label: WORKSPACE_LESSON_TYPE_LABELS[value],
}));

const HEADER_ICON_BUTTON_CLASS =
  "inline-flex size-8 items-center justify-center rounded-lg transition-colors";
const HEADER_ICON_BUTTON_NEUTRAL_CLASS = "text-slate-400 hover:bg-white/5 hover:text-white";

// The panel toggles keep one accessible name and carry their state in
// aria-pressed; a name that flipped with the state ("Hide …", pressed) would
// read as the opposite of what is showing. The title keeps the action as a
// hover hint.

export function FileSidebarToggleButton() {
  const isCollapsed = useWorkspaceSidebarCollapsed();
  const { setSidebarCollapsed } = useWorkspaceActions();
  const isOpen = !isCollapsed;

  return (
    <button
      type="button"
      aria-label="File explorer"
      aria-pressed={isOpen}
      title={isOpen ? "Hide file explorer" : "Show file explorer"}
      onClick={() => setSidebarCollapsed(!isCollapsed)}
      className={`${HEADER_ICON_BUTTON_CLASS} ${HEADER_ICON_BUTTON_NEUTRAL_CLASS}`}
    >
      {isOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
    </button>
  );
}

export function PreviewHeaderButton() {
  const { isOpen, togglePreview } = usePreviewPanel();

  return (
    <button
      data-tour="preview"
      type="button"
      aria-label="Preview"
      aria-pressed={isOpen}
      title={isOpen ? "Close preview" : "Open preview"}
      onClick={togglePreview}
      className={`${HEADER_ICON_BUTTON_CLASS} ${HEADER_ICON_BUTTON_NEUTRAL_CLASS}`}
    >
      {isOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
    </button>
  );
}

export function WhiteboardHeaderButton() {
  const { isOpen, setOpen } = useWhiteboardContext();
  const slides = useSlidesContext();
  const collaboration = useOptionalCollaboration();

  if (collaboration?.provider && !collaboration.teaching.initialized) return null;

  return (
    <button
      data-tour="whiteboard"
      type="button"
      aria-label="Whiteboard"
      aria-pressed={isOpen}
      title={isOpen ? "Close whiteboard" : "Open whiteboard"}
      onClick={() => {
        collaboration?.stopFollowing("local-surface-change");
        if (!isOpen && slides.previewState.isOpen) slides.closePresentation();
        setOpen(!isOpen);
      }}
      className={`${HEADER_ICON_BUTTON_CLASS} ${isOpen ? "bg-[#273449] text-white" : HEADER_ICON_BUTTON_NEUTRAL_CLASS}`}
    >
      <PenTool size={16} />
    </button>
  );
}

export function WorkspaceSettingsButton({ showImportExport }: { showImportExport: boolean }) {
  const [isEnvironmentModalOpen, setIsEnvironmentModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const { resetRuntime, updateRunnerConfig } = useWebContainerRuntimeActions();
  const { exportAsFile, importFromFile, loadRecording } = useNextEditorActions();
  const { currentRecording } = useNextEditorMetadata();
  const { getProject, reconcileExternalProject, saveProject } = useWorkspaceActions();
  const fileCount = useWorkspaceFileCount();
  const lessonType = useWorkspaceLessonType();
  const { hasUnsavedChanges } = useWorkspaceDirtyState();

  const activeLessonOption =
    LESSON_TYPE_OPTIONS.find((option) => option.value === lessonType) ?? LESSON_TYPE_OPTIONS[0];

  // Asks before the workspace is replaced. With something to discard, the
  // question names it and `consequence` says what replaces it; with nothing,
  // `emptyWorkspacePrompt` is the whole question.
  const confirmReplaceWorkspace = (consequence: string, emptyWorkspacePrompt: string) =>
    window.confirm(
      hasUnsavedChanges
        ? `Discard the current workspace and unsaved changes? ${consequence}`
        : fileCount > 0
          ? `Discard the current workspace? ${consequence}`
          : emptyWorkspacePrompt,
    );

  // Starter templates are split into per-framework chunks, so the starter is
  // fetched on demand before it replaces the workspace.
  const replaceWithStarter = async (
    starterLessonType: WorkspaceLessonType,
    { resetRuntimeFirst = false } = {},
  ) => {
    const starterProject = await createStarterWorkspaceForLessonType(starterLessonType);

    // In the same task as the swap, never after the save below: the swap's render
    // already auto-starts the new project, and a later reset cancels that start.
    if (resetRuntimeFirst) {
      resetRuntime();
    }
    reconcileExternalProject(starterProject);
    await saveProject();
    updateRunnerConfig({ enabled: true });
  };

  // Every action runs from a menu item, which unmounts as the menu closes and
  // would drop focus to <body>. Focus goes back to the Settings button first,
  // before any confirm or file picker, so the browser returns there after the
  // native UI too. `restoreFocus` is false only where something else takes
  // focus: the environment dialog (which returns it to the button on close)
  // and the product tour.
  const closeMenu = (restoreFocus = true) => {
    setIsMenuOpen(false);
    if (restoreFocus) {
      settingsButtonRef.current?.focus();
    }
  };

  const handleEditEnvironment = () => {
    closeMenu(false);
    setIsEnvironmentModalOpen(true);
  };

  const handleImportRecording = async () => {
    closeMenu();

    try {
      const importedRecordings = await importFromFile();
      if (importedRecordings.length > 0) {
        loadRecording(importedRecordings[0]);
        analytics.capture("recording_imported");
      }
    } catch (error) {
      // These rejections are all descriptive and all actionable ("bad SCR3
      // magic", "No .ne file selected", …). Logging only meant the menu closed,
      // nothing changed, and the user concluded the button was broken and
      // retried the same file. Cancelling the picker fires `cancel`, not
      // `change`, so this cannot fire spuriously on cancel. Matches the zip
      // import path in this same component.
      console.error("Import failed:", error);
      window.alert(
        error instanceof Error ? error.message : "That recording could not be imported.",
      );
    }
  };

  const handleExportRecording = async () => {
    closeMenu();

    if (!currentRecording) {
      return;
    }

    try {
      await exportAsFile(currentRecording);
      // The take is saved to disk now, so it no longer needs its recovery draft.
      void discardRecordingDraftFor(currentRecording.id);
      analytics.capture("recording_exported", {
        recording_duration: currentRecording.duration,
      });
    } catch (error) {
      console.error("Export failed:", error);
      window.alert(
        error instanceof Error ? error.message : "That recording could not be exported.",
      );
    }
  };

  const handleDownload = async () => {
    closeMenu();

    try {
      await downloadWorkspaceProjectAsZip(getProject());
      analytics.capture("workspace_downloaded", { lesson_type: lessonType });
    } catch (error) {
      console.error("Zip download failed:", error);
      window.alert(
        error instanceof Error ? error.message : "That project could not be downloaded.",
      );
    }
  };

  const openImportDialog = () => {
    closeMenu();
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

    if (
      !confirmReplaceWorkspace(
        `Importing will replace it with "${file.name}".`,
        `Import "${file.name}"?`,
      )
    ) {
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

    // Imported projects ship their own dependencies, so tear the runtime down for
    // a fresh mount + `pnpm install`, in the same task as the swap (see
    // replaceWithStarter).
    resetRuntime();
    reconcileExternalProject(importedProject);
    await saveProject();
    updateRunnerConfig({ enabled: true });
    analytics.capture("project_zip_imported");
  };

  const handleCreateNewEditor = async () => {
    // "New Editor" starts over within the current framework, so reset to a fresh
    // starter of the active lesson type rather than always falling back to HTML/CSS.
    const currentOption = activeLessonOption;

    closeMenu();

    if (
      !confirmReplaceWorkspace(
        `This will reset the editor to a fresh ${currentOption.label} project.`,
        `Create a new ${currentOption.label} project?`,
      )
    ) {
      return;
    }

    // Same framework as before, so its dependencies are already installed — just
    // swap the files in (the running dev server picks them up) and keep it running.
    await replaceWithStarter(currentOption.value);
  };

  const handleSelectLessonType = async (nextLessonType: WorkspaceLessonType) => {
    if (lessonType === nextLessonType) {
      closeMenu();
      return;
    }

    const nextOption = LESSON_TYPE_OPTIONS.find((option) => option.value === nextLessonType);

    if (!nextOption) {
      closeMenu();
      return;
    }

    const nextLessonLabel = `a fresh ${nextOption.label} project`;

    closeMenu();

    if (
      !confirmReplaceWorkspace(
        `Switching will replace it with ${nextLessonLabel}.`,
        `Switch to ${nextLessonLabel}?`,
      )
    ) {
      return;
    }

    // Each framework ships different dependencies, so the runtime is torn down
    // for a fresh mount + `pnpm install` of the new project.
    await replaceWithStarter(nextOption.value, { resetRuntimeFirst: true });
    analytics.capture("lesson_type_selected", { lesson_type: nextLessonType });
  };

  return (
    <>
      <div
        className={`relative ${isMenuOpen ? "z-2147483647" : ""}`}
        onKeyDown={(event) => {
          if (event.key === "Escape" && isMenuOpen) {
            event.stopPropagation();
            closeMenu();
          }
        }}
      >
        <button
          ref={settingsButtonRef}
          data-tour="settings"
          type="button"
          aria-label="Open workspace settings"
          aria-expanded={isMenuOpen}
          aria-haspopup="menu"
          onClick={() => setIsMenuOpen((current) => !current)}
          className={`${HEADER_ICON_BUTTON_CLASS} ${HEADER_ICON_BUTTON_NEUTRAL_CLASS}`}
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
              {/* Outside the showImportExport block on purpose: see isVisible. */}
              <StarterTemplateSubmenu
                isVisible={showImportExport}
                options={LESSON_TYPE_OPTIONS}
                activeLessonType={lessonType}
                onSelect={(nextLessonType) => {
                  void handleSelectLessonType(nextLessonType);
                }}
              />
              {showImportExport ? (
                <>
                  <div className="my-1 h-px bg-slate-700" />

                  <SettingsMenuItem
                    icon={FilePlus2}
                    label="New Editor"
                    onClick={() => {
                      void handleCreateNewEditor();
                    }}
                  />

                  <div className="my-1 h-px bg-slate-700" />

                  <SettingsMenuItem
                    icon={FileDown}
                    label="Import Recording (.ne)"
                    onClick={() => {
                      void handleImportRecording();
                    }}
                  />
                  <SettingsMenuItem
                    icon={FileUp}
                    label="Export Recording (.ne)"
                    onClick={() => {
                      void handleExportRecording();
                    }}
                    disabled={!currentRecording}
                    // Greyed out, not just disabled, while there is nothing to export.
                    className={`w-full rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors ${
                      currentRecording
                        ? "text-slate-200 hover:bg-slate-700 hover:text-white"
                        : "cursor-not-allowed text-slate-500"
                    }`}
                  />
                  <div className="my-1 h-px bg-slate-700" />

                  <SettingsMenuItem
                    icon={FileArchive}
                    label="Import Project (.zip)"
                    onClick={openImportDialog}
                  />
                </>
              ) : null}
              {lessonRunsInWebContainer(lessonType) ? (
                <SettingsMenuItem
                  icon={Variable}
                  label="Edit Environment"
                  onClick={handleEditEnvironment}
                />
              ) : null}
              <SettingsMenuItem
                icon={Download}
                label="Download As Zip"
                onClick={() => {
                  void handleDownload();
                }}
              />

              {showImportExport ? (
                <>
                  <div className="my-1 h-px bg-slate-700" />

                  <SettingsMenuItem
                    icon={Compass}
                    label="Take a Tour"
                    onClick={() => {
                      closeMenu(false);
                      void startTour({ force: true });
                    }}
                  />
                </>
              ) : null}
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
        <EnvironmentVariablesDialog
          onClose={() => setIsEnvironmentModalOpen(false)}
          returnFocusRef={settingsButtonRef}
        />
      )}
    </>
  );
}

interface EditorHeaderProps {
  showImportExport: boolean;
  /** Replaces the static "Editor" label — e.g. a /learn/:slug breadcrumb trail. */
  breadcrumb?: ReactNode;
}

function EditorHeader({ showImportExport, breadcrumb }: EditorHeaderProps) {
  const { isSaving, errorMessage } = useWorkspaceSaveStatus();
  const lessonType = useWorkspaceLessonType();

  return (
    <div className="bg-[#11141c] px-4 py-1.5 flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0">
        <FileSidebarToggleButton />
        {breadcrumb ?? (
          <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Editor</span>
        )}
        {isSaving ? (
          <span className="text-[10px] text-slate-500" role="status">
            Saving…
          </span>
        ) : errorMessage ? (
          <span
            className="max-w-64 truncate text-[10px] text-rose-400"
            role="alert"
            title={errorMessage}
          >
            Workspace storage error: {errorMessage}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <CollaborationPanel />
        <WorkspaceSettingsButton showImportExport={showImportExport} />
        <div className="h-4 w-px bg-slate-700 mx-1" />
        <div className="flex items-center gap-2">
          <WhiteboardHeaderButton />
          <SlidesButton presentationToggleOnly={!showImportExport} />
          {/* Go, Kotlin, Rust, and Python lessons have no preview surface — the
              control is absent, not disabled. */}
          {lessonSupportsPreview(lessonType) ? <PreviewHeaderButton /> : null}
        </div>
      </div>
    </div>
  );
}

export default EditorHeader;
