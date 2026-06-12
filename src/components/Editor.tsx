import { lazy, memo, Suspense } from "react";
import MediaControls from "./MediaControls";
import DragDropOverlay from "./DragDropOverlay";
import SlidePanel from "./SlidePanel";
import FloatingPlayButton from "./FloatingPlayButton";
import { NextEditorProvider } from "../contexts/NextEditorProvider.tsx";
import { NextEditorDomainAdaptersProvider } from "../contexts/NextEditorDomainAdaptersContext";
import { SlidesProvider } from "../contexts/SlidesContext";
import { WebContainerRuntimeProvider } from "../contexts/WebContainerRuntimeProvider";
import { WorkspaceProvider } from "../contexts/WorkspaceProvider";
import { useDragAndDropUrl } from "../hooks/useDragAndDropUrl";
import { useWorkspaceLessonType } from "../hooks/useWorkspace";
import { useUrlQuery } from "../hooks/useUrlQuery";
import CursorComponent from "./Cursor.tsx";

const CodeEditor = lazy(() => import("./CodeEditor"));
const Preview = lazy(() => import("./Preview"));
const TerminalPanel = lazy(() => import("./TerminalPanel"));

function EditorSurfaceFallback() {
  return (
    <div className="h-full flex items-center justify-center bg-slate-950">
      <div className="size-8 animate-spin rounded-full border-2 border-white/15 border-t-white/80" />
    </div>
  );
}

export const EditorLayout = memo(function EditorLayout() {
  const { isDragging, isLoading: dragLoading } = useDragAndDropUrl();
  const { isLoading: urlLoading } = useUrlQuery();
  const lessonType = useWorkspaceLessonType();

  const isLoading = dragLoading || urlLoading;

  // Check URL for showImportExport parameter (defaults to true if not specified)
  const urlParams = new URLSearchParams(window.location.search);
  const readOnly = urlParams.get("readOnly") === "true";

  return (
    <div className="h-dvh flex flex-col bg-slate-950 text-white overflow-hidden">
      <div className="flex-1 relative overflow-hidden">
        <Suspense fallback={<EditorSurfaceFallback />}>
          <CodeEditor showImportExport={!readOnly} />
        </Suspense>
        <CursorComponent />
        <Suspense fallback={null}>
          <Preview />
        </Suspense>
        {lessonType === "node.js" ? (
          <Suspense fallback={null}>
            <TerminalPanel />
          </Suspense>
        ) : null}
        <SlidePanel />
      </div>

      <MediaControls recordMode={!readOnly} />

      <DragDropOverlay isDragging={isDragging} isLoading={isLoading} />

      <FloatingPlayButton />
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
              <EditorLayout />
            </SlidesProvider>
          </NextEditorProvider>
        </NextEditorDomainAdaptersProvider>
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>
  );
}
