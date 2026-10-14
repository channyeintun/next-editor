import { useRef, useState } from "react";
import {
  Compass,
  Download,
  FileArchive,
  FileDown,
  FileUp,
  Settings,
  SquarePen,
  Variable,
} from "lucide-react";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";
import { useWebContainerRuntimeActions } from "../../hooks/useWebContainerRuntime";
import { analytics } from "../../utils/analytics";
import { downloadWorkspaceProjectAsZip } from "../../utils/workspaceZip";
import {
  importWorkspaceProjectFromZip,
  WorkspaceZipImportError,
} from "../../utils/workspaceZipImport";
import {
  useWorkspaceActions,
  useWorkspaceDirtyState,
  useWorkspaceFileCount,
  useWorkspaceLessonType,
} from "../../hooks/useWorkspace";
import type { WorkspaceLessonType, WorkspaceProject } from "../../types/workspace";
import {
  lessonRunsInWebContainer,
  WORKSPACE_LESSON_TYPE_LABELS,
  WORKSPACE_LESSON_TYPES,
} from "../../types/lessonTypes";
import { createStarterWorkspaceForLessonType } from "../../starters";
import { startTour } from "../tour/productTour";
import { discardRecordingDraftFor } from "../../storage/recordingDrafts/recordingDraftJournal";
import EnvironmentVariablesDialog from "./EnvironmentVariablesDialog";
import SettingsMenuItem from "./SettingsMenuItem";
import StarterTemplateSubmenu, { type LessonTypeOption } from "./StarterTemplateSubmenu";
import { HEADER_ICON_BUTTON_CLASS, HEADER_ICON_BUTTON_NEUTRAL_CLASS } from "./headerButtonClasses";
import HoverRing from "../hoverRing/HoverRing";

const LESSON_TYPE_OPTIONS: LessonTypeOption[] = WORKSPACE_LESSON_TYPES.map((value) => ({
  value,
  label: WORKSPACE_LESSON_TYPE_LABELS[value],
}));

/** The header's Settings button and the workspace menu it opens. */
export default function WorkspaceSettingsButton({ isAuthoring }: { isAuthoring: boolean }) {
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

  // Puts `project` in place of the workspace, saves it, and turns the runner
  // on. Every path that replaces the workspace goes through here, because the
  // order is the fix: the reset runs in the same task as the swap, never after
  // the save below. The swap's render already auto-starts the new project, and
  // a later reset cancels that start.
  const swapInWorkspace = async (project: WorkspaceProject, { resetRuntimeFirst = false } = {}) => {
    if (resetRuntimeFirst) {
      resetRuntime();
    }
    reconcileExternalProject(project);
    await saveProject();
    updateRunnerConfig({ enabled: true });
  };

  // Starter templates are split into per-framework chunks, so the starter is
  // fetched on demand before it replaces the workspace. A chunk that cannot load
  // (offline, or gone after a deploy) gets an alert, as the other actions here
  // do, and leaves the workspace and runtime as they were. Returns whether the
  // workspace was replaced.
  const replaceWithStarter = async (
    starterLessonType: WorkspaceLessonType,
    options: { resetRuntimeFirst?: boolean } = {},
  ): Promise<boolean> => {
    let project: WorkspaceProject;
    try {
      project = await createStarterWorkspaceForLessonType(starterLessonType);
    } catch (error) {
      console.error("Starter load failed:", error);
      window.alert(
        "That starter could not be loaded. Check your connection or reload the page, then try again.",
      );
      return false;
    }

    await swapInWorkspace(project, options);
    return true;
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

    // Imported projects ship their own dependencies, so the runtime is torn
    // down for a fresh mount + `pnpm install`.
    await swapInWorkspace(importedProject, { resetRuntimeFirst: true });
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
    if (await replaceWithStarter(nextOption.value, { resetRuntimeFirst: true })) {
      analytics.capture("lesson_type_selected", { lesson_type: nextLessonType });
    }
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
          <HoverRing />
        </button>

        {isMenuOpen ? (
          <>
            <div className="fixed inset-0 z-2147483646" onClick={() => setIsMenuOpen(false)} />
            <div
              role="menu"
              className="absolute right-0 top-full z-2147483647 mt-2 w-60 rounded-xl border border-slate-700 bg-[#151821] p-1 shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
            >
              {/* The submenu hides itself from isAuthoring: see isVisible. */}
              <StarterTemplateSubmenu
                isVisible={isAuthoring}
                options={LESSON_TYPE_OPTIONS}
                activeLessonType={lessonType}
                onSelect={(nextLessonType) => {
                  void handleSelectLessonType(nextLessonType);
                }}
              />
              {isAuthoring ? (
                <>
                  <div className="my-1 h-px bg-slate-700" />

                  <SettingsMenuItem
                    icon={SquarePen}
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

              {isAuthoring ? (
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
