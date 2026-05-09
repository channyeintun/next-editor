import CodeEditor from "./CodeEditor";
import MediaControls from "./MediaControls";
import DragDropOverlay from "./DragDropOverlay";
import Preview from "./Preview.tsx";
import SlidePanel from "./SlidePanel";
import TerminalPanel from "./TerminalPanel";
import FloatingPlayButton from "./FloatingPlayButton";
import { NextEditorProvider } from "../contexts/NextEditorProvider.tsx";
import { SlidesProvider } from "../contexts/SlidesContext";
import { WebContainerRuntimeProvider } from "../contexts/WebContainerRuntimeProvider";
import { WorkspaceProvider } from "../contexts/WorkspaceProvider";
import { useDragAndDropUrl } from "../hooks/useDragAndDropUrl";
import { useWorkspaceMetadata } from "../hooks/useWorkspace";
import { useUrlQuery } from "../hooks/useUrlQuery";
import CursorComponent from "./Cursor.tsx";

export function EditorLayout() {
  const { isDragging, isLoading: dragLoading } = useDragAndDropUrl();
  const { isLoading: urlLoading } = useUrlQuery();
  const { lessonType } = useWorkspaceMetadata();

  const isLoading = dragLoading || urlLoading;

  // Check URL for showImportExport parameter (defaults to true if not specified)
  const urlParams = new URLSearchParams(window.location.search);
  const readOnly = urlParams.get("readOnly") === "true";

  return (
    <div className="h-dvh flex flex-col bg-slate-950 text-white overflow-hidden">
      <div className="flex-1 relative overflow-hidden">
        <CodeEditor showImportExport={!readOnly} />
        <CursorComponent />
        <Preview />
        {lessonType === "spa" ? <TerminalPanel /> : null}
        <SlidePanel />
      </div>

      <MediaControls recordMode={!readOnly} />

      <DragDropOverlay isDragging={isDragging} isLoading={isLoading} />

      <FloatingPlayButton />
    </div>
  );
}

export default function Editor() {
  return (
    <WorkspaceProvider>
      <WebContainerRuntimeProvider>
        <NextEditorProvider>
          <SlidesProvider>
            <EditorLayout />
          </SlidesProvider>
        </NextEditorProvider>
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>
  );
}
