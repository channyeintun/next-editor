import { lazy } from "react";
import MediaControls from "./MediaControls";
import DragDropOverlay from "./DragDropOverlay";
import SlidePanel from "./SlidePanel";
import FloatingPlayButton from "./FloatingPlayButton";
import { NextEditorProvider } from "../contexts/NextEditorProvider.tsx";
import { NextEditorDomainAdaptersProvider } from "../contexts/NextEditorDomainAdaptersContext";
import { SlidesProvider } from "../contexts/SlidesContext";
import { WebContainerRuntimeProvider } from "../contexts/WebContainerRuntimeProvider";
import { WorkspaceProvider } from "../contexts/WorkspaceProvider";
import { PreviewPanelProvider } from "../contexts/PreviewPanelContext";
import { useDragAndDropUrl } from "../hooks/useDragAndDropUrl";
import { useWorkspaceLessonType } from "../hooks/useWorkspace";
import { lessonRunsInWebContainer } from "../types/workspace";
import { useUrlQuery } from "../hooks/useUrlQuery";
import CameraOverlay from "./CameraOverlay";
import CursorComponent from "./Cursor.tsx";
import LoadingSpinner from "./LoadingSpinner.tsx";

const CodeEditor = lazy(() => import("./CodeEditor"));
const TerminalPanel = lazy(() => import("./TerminalPanel"));

export function EditorLayout() {
  const { isLoading: urlLoading } = useUrlQuery();
  const { isDragging } = useDragAndDropUrl();
  const lessonType = useWorkspaceLessonType();

  // Check URL for showImportExport parameter (defaults to true if not specified)
  const urlParams = new URLSearchParams(window.location.search);
  const readOnly = urlParams.get("readOnly") === "true";
  // Enlarge the playback controls for small embeds (e.g. a scaled-down demo iframe).
  const largeControls = urlParams.get("largeControls") === "true";

  return (
    <div className="h-dvh flex flex-col text-white overflow-hidden" data-cursor-replay-target="app">
      <div className="flex-1 relative overflow-hidden" data-cursor-replay-target="editor-surface">
        <CodeEditor showImportExport={!readOnly} />
        <CursorComponent />
        <CameraOverlay />
        {lessonRunsInWebContainer(lessonType) ? <TerminalPanel large={largeControls} /> : null}
        <SlidePanel />
      </div>

      <MediaControls recordMode={!readOnly} large={largeControls} />

      <DragDropOverlay isDragging={isDragging} />

      {urlLoading ? (
        <LoadingSpinner className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
      ) : (
        <FloatingPlayButton />
      )}
    </div>
  );
}

export default function Editor() {
  return (
    <WorkspaceProvider>
      <WebContainerRuntimeProvider>
        <NextEditorDomainAdaptersProvider>
          <NextEditorProvider>
            <SlidesProvider>
              <PreviewPanelProvider>
                <EditorLayout />
              </PreviewPanelProvider>
            </SlidesProvider>
          </NextEditorProvider>
        </NextEditorDomainAdaptersProvider>
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>
  );
}
