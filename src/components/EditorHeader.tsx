import type { ReactNode } from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PenTool,
} from "lucide-react";
import { usePreviewPanel } from "../contexts/PreviewPanelContext";
import { useWhiteboardContext } from "../contexts/WhiteboardContext";
import {
  useWorkspaceActions,
  useWorkspaceLessonType,
  useWorkspaceSaveStatus,
  useWorkspaceSidebarCollapsed,
} from "../hooks/useWorkspace";
import { lessonSupportsPreview } from "../types/lessonTypes";
import SlidesButton from "./SlidesButton";
import CollaborationPanel from "./CollaborationPanel";
import WorkspaceSettingsButton from "./editorHeader/WorkspaceSettingsButton";
import QuickOpenButton from "./quickOpen/QuickOpenButton";
import {
  HEADER_ICON_BUTTON_CLASS,
  HEADER_ICON_BUTTON_NEUTRAL_CLASS,
} from "./editorHeader/headerButtonClasses";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import { useSlidesContext } from "../contexts/SlidesContext";

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

interface EditorHeaderProps {
  isAuthoring: boolean;
  /** Replaces the static "Editor" label — e.g. a /learn/:slug breadcrumb trail. */
  breadcrumb?: ReactNode;
}

function EditorHeader({ isAuthoring, breadcrumb }: EditorHeaderProps) {
  const { isSaving, errorMessage } = useWorkspaceSaveStatus();
  const lessonType = useWorkspaceLessonType();

  return (
    <div className="bg-[#11141c] px-4 py-1.5 flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0">
        <FileSidebarToggleButton />
        <QuickOpenButton />
        {breadcrumb ?? (
          <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">Editor</span>
        )}
        {/* Stays mounted and only its text changes, like the load status in
            Editor.tsx: a status region inserted already filled is often not
            announced. sr-only while empty, so it adds no flex gap. */}
        <span role="status" className={isSaving ? "text-[10px] text-slate-300" : "sr-only"}>
          {isSaving ? "Saving…" : ""}
        </span>
        {!isSaving && errorMessage ? (
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
        <WorkspaceSettingsButton isAuthoring={isAuthoring} />
        <div className="h-4 w-px bg-slate-700 mx-1" />
        <div className="flex items-center gap-2">
          <WhiteboardHeaderButton />
          <SlidesButton presentationToggleOnly={!isAuthoring} />
          {/* Go, Kotlin, Rust, and Python lessons have no preview surface — the
              control is absent, not disabled. */}
          {lessonSupportsPreview(lessonType) ? <PreviewHeaderButton /> : null}
        </div>
      </div>
    </div>
  );
}

export default EditorHeader;
