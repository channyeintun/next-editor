import { lazy, useEffect, useRef } from "react";
import MediaControls from "./MediaControls";
import DragDropOverlay from "./DragDropOverlay";
import SlidePanel from "./SlidePanel";
import FloatingPlayButton from "./FloatingPlayButton";
import { NextEditorProvider } from "../contexts/NextEditorProvider.tsx";
import { PreviewAdapterHandleProvider } from "../contexts/PreviewAdapterHandleContext";
import { SlidesStoreProvider } from "../contexts/SlidesStoreContext";
import { RuntimePanelStoreProvider } from "../contexts/RuntimePanelStoreContext";
import { SlidesProvider } from "../contexts/SlidesContext";
import { WebContainerRuntimeProvider } from "../contexts/WebContainerRuntimeProvider";
import { WorkspaceProvider } from "../contexts/WorkspaceProvider";
import { PreviewPanelProvider } from "../contexts/PreviewPanelContext";
import { useDragAndDropUrl } from "../hooks/useDragAndDropUrl";
import { useWorkspaceLessonType } from "../hooks/useWorkspace";
import { lessonRunsInWebContainer } from "../types/workspace";
import { useUrlQuery } from "../hooks/useUrlQuery";
import CameraOverlay from "./CameraOverlay";
import CaptionsOverlay from "./CaptionsOverlay";
import CursorComponent from "./Cursor.tsx";
import LoadingSpinner from "./LoadingSpinner.tsx";
import { ApiClientStoreProvider } from "../contexts/ApiClientStoreContext";
import { CaptionStoreProvider } from "../contexts/CaptionStoreContext";
import { startTour } from "./tour/productTour";

const CodeEditor = lazy(() => import("./CodeEditor"));
const TerminalPanel = lazy(() => import("./TerminalPanel"));

export interface EditorProps {
  /** Force read-only playback (hides import/export, record mode, tour). Falls back
   *  to the `?readOnly=true` query param when omitted. */
  readOnly?: boolean;
  /** Recording to load (`.ne` path or URL). Overrides the `?url=` query param. */
  recordingUrl?: string;
  /** Enlarge playback controls for small embeds. Falls back to `?largeControls=true`. */
  largeControls?: boolean;
  /** Fill the parent (`h-full`) instead of the viewport (`h-dvh`), so the editor can
   *  sit below other chrome (e.g. the /learn detail header). Defaults to viewport. */
  fill?: boolean;
}

export function EditorLayout({
  readOnly: readOnlyProp,
  recordingUrl,
  largeControls: largeControlsProp,
  fill = false,
}: EditorProps = {}) {
  const { isLoading: urlLoading } = useUrlQuery(recordingUrl);
  const { isDragging } = useDragAndDropUrl();
  const lessonType = useWorkspaceLessonType();

  // Props win; otherwise fall back to URL params so the /code route keeps working.
  const urlParams = new URLSearchParams(window.location.search);
  const readOnly = readOnlyProp ?? urlParams.get("readOnly") === "true";
  // Enlarge the playback controls for small embeds (e.g. a scaled-down demo iframe).
  const largeControls = largeControlsProp ?? urlParams.get("largeControls") === "true";

  const tourStartedRef = useRef(false);

  useEffect(() => {
    // Don't tour inside read-only embeds (the landing-page demo iframe), and wait
    // until any URL-driven recording load has finished.
    if (urlLoading || readOnly || tourStartedRef.current) {
      return;
    }

    // Defer one frame so the lazily-mounted editor chrome (header, runner dock)
    // has painted before we query the `data-tour` targets. The frame is left to
    // fire on its own — cancelling it in cleanup would let StrictMode's dev
    // double-invoke abort the tour entirely (run #1 schedules, cleanup cancels,
    // run #2 short-circuits on the ref), so the tour would never auto-start.
    tourStartedRef.current = true;
    requestAnimationFrame(() => {
      startTour();
    });
  }, [urlLoading, readOnly]);

  return (
    <div
      className={`${fill ? "h-full" : "h-dvh"} flex flex-col text-white overflow-hidden`}
      data-cursor-replay-target="app"
    >
      <div className="flex-1 relative overflow-hidden" data-cursor-replay-target="editor-surface">
        <CodeEditor showImportExport={!readOnly} />
        <CursorComponent />
        <CameraOverlay />
        <CaptionsOverlay />
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

export default function Editor(props: EditorProps = {}) {
  return (
    <WorkspaceProvider>
      <WebContainerRuntimeProvider>
        <SlidesStoreProvider>
          <RuntimePanelStoreProvider>
            <PreviewAdapterHandleProvider>
              <CaptionStoreProvider>
                <ApiClientStoreProvider>
                  <NextEditorProvider>
                    <SlidesProvider>
                      <PreviewPanelProvider>
                        <EditorLayout {...props} />
                      </PreviewPanelProvider>
                    </SlidesProvider>
                  </NextEditorProvider>
                </ApiClientStoreProvider>
              </CaptionStoreProvider>
            </PreviewAdapterHandleProvider>
          </RuntimePanelStoreProvider>
        </SlidesStoreProvider>
      </WebContainerRuntimeProvider>
    </WorkspaceProvider>
  );
}
