import { lazy, memo, useState } from "react";
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
import { useUrlQuery } from "../hooks/useUrlQuery";
import CameraOverlay from "./CameraOverlay";
import CursorComponent from "./Cursor.tsx";
import LoadingSpinner from "./LoadingSpinner.tsx";

const CodeEditor = lazy(() => import("./CodeEditor"));
const TerminalPanel = lazy(() => import("./TerminalPanel"));

export const EditorLayout = memo(function EditorLayout() {
  const { isLoading: urlLoading } = useUrlQuery();
  const { isDragging, isLoading: dragDropLoading } = useDragAndDropUrl();
  const [isHeaderImportLoading, setIsHeaderImportLoading] = useState(false);
  const lessonType = useWorkspaceLessonType();

  // Check URL for showImportExport parameter (defaults to true if not specified)
  const urlParams = new URLSearchParams(window.location.search);
  const readOnly = urlParams.get("readOnly") === "true";

  return (
    <div
      className="h-dvh flex flex-col bg-slate-950 text-white overflow-hidden"
      data-cursor-replay-target="app"
    >
      <div className="flex-1 relative overflow-hidden" data-cursor-replay-target="editor-surface">
        <CodeEditor showImportExport={!readOnly} onImportLoadingChange={setIsHeaderImportLoading} />
        <CursorComponent />
        <CameraOverlay />
        {lessonType === "node.js" ? <TerminalPanel /> : null}
        <SlidePanel />
      </div>

      <MediaControls recordMode={!readOnly} />

      <DragDropOverlay isDragging={isDragging} />

      {urlLoading || dragDropLoading || isHeaderImportLoading ? (
        <LoadingSpinner className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
      ) : (
        <FloatingPlayButton />
      )}
    </div>
  );
});

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
