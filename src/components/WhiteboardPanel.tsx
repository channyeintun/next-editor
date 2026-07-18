import { useEffect, useRef } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { CaptureUpdateAction, Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AppState, BinaryFiles, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import { useWhiteboardContext } from "../contexts/WhiteboardContext";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import type { WhiteboardElementJSON } from "../core/src/whiteboard";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";

// Image embeds are out of scope for v1 (binary files aren't recorded into the
// .ne, see whiteboard-plan.md §4) — this also gates paste/drag-drop of images,
// not just the toolbar button (Excalidraw checks it in insertImageElement).
const UI_OPTIONS = { tools: { image: false } };

// Excalidraw mutates the element objects it is handed in place (fractional-index
// sync inside updateScene, and every live edit after playback hands control back).
// The store's elements are the same objects held by `recording.whiteboardEvents`
// and the replay fold cache, so hand Excalidraw per-element copies to keep the
// recorded data pristine.
function toExcalidrawElements(
  elements: readonly WhiteboardElementJSON[],
): OrderedExcalidrawElement[] {
  return elements.map((element) => ({ ...element })) as unknown as OrderedExcalidrawElement[];
}

export default function WhiteboardPanel() {
  const {
    scene,
    sceneUpdateSource,
    isOpen,
    setOpen,
    setMaximized,
    handleExcalidrawChange,
  } = useWhiteboardContext();
  const { usesPlaybackModel } = useNextEditorMetadata();
  const collaboration = useOptionalCollaboration();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const contentReadOnly =
    usesPlaybackModel || Boolean(collaboration?.provider && !collaboration.canWrite);

  // External state (remote room projection, followed viewport, playback, or a
  // restored store) drives the mounted canvas. A canvas-origin scene is the
  // controller's throttled snapshot of the gesture already in progress; feeding
  // it back through updateScene would rewind that gesture to the last 100 ms
  // checkpoint.
  useEffect(() => {
    if (!apiRef.current || (!usesPlaybackModel && sceneUpdateSource === "canvas")) return;
    apiRef.current.updateScene({
      elements: toExcalidrawElements(scene.elements),
      appState: {
        scrollX: scene.view.scrollX,
        scrollY: scene.view.scrollY,
        zoom: { value: scene.view.zoom as NormalizedZoomValue },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [scene, sceneUpdateSource, usesPlaybackModel]);

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-90 bg-[#0b0d12]/90 opacity-0 animate-[fade-in_0.2s_ease-out_forwards] motion-reduce:animate-none motion-reduce:opacity-100"
        onClick={() => {
          collaboration?.stopFollowing("local-whiteboard-input");
          setOpen(false);
        }}
      />
      <div
        className={`fixed z-100 flex flex-col overflow-hidden bg-slate-900 shadow-2xl transition-[inset,border-radius] motion-reduce:transition-none ${
          scene.isMaximized
            ? "inset-0 rounded-none"
            : "top-[5%] left-[5%] right-[5%] bottom-[5%] rounded-2xl"
        }`}
      >
        <div className="flex items-center justify-between px-4 py-2 bg-[#11141c] border-b border-white/10 shrink-0">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            Whiteboard
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={scene.isMaximized ? "Restore whiteboard" : "Maximize whiteboard"}
              aria-pressed={scene.isMaximized}
              onClick={() => {
                collaboration?.stopFollowing("local-whiteboard-input");
                setMaximized(!scene.isMaximized);
              }}
              className="flex size-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
            >
              {scene.isMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button
              type="button"
              aria-label="Close whiteboard"
              onClick={() => {
                collaboration?.stopFollowing("local-whiteboard-input");
                setOpen(false);
              }}
              className="flex size-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        {/* The arbitrary variant hides the library sidebar toggle — the library
            has no recording semantics and Excalidraw exposes no UIOptions flag
            for it. Zen mode is a default (via initialData, so the presenter can
            still toggle it), not the controlled `zenModeEnabled` prop. */}
        <div
          className="relative flex-1 [&_.default-sidebar-trigger]:hidden"
          onPointerDownCapture={() => collaboration?.stopFollowing("local-whiteboard-input")}
          onWheelCapture={() => collaboration?.stopFollowing("local-whiteboard-input")}
          onKeyDownCapture={() => collaboration?.stopFollowing("local-whiteboard-input")}
        >
          <Excalidraw
            excalidrawAPI={(api) => {
              apiRef.current = api;
            }}
            theme="dark"
            viewModeEnabled={contentReadOnly}
            UIOptions={UI_OPTIONS}
            initialData={{
              elements: toExcalidrawElements(scene.elements),
              appState: {
                scrollX: scene.view.scrollX,
                scrollY: scene.view.scrollY,
                zoom: { value: scene.view.zoom as NormalizedZoomValue },
                zenModeEnabled: true,
              },
            }}
            onChange={(
              elements: readonly OrderedExcalidrawElement[],
              appState: AppState,
              _files: BinaryFiles,
            ) => {
              handleExcalidrawChange(
                elements as unknown as WhiteboardElementJSON[],
                {
                  scrollX: appState.scrollX,
                  scrollY: appState.scrollY,
                  zoom: appState.zoom.value,
                },
                contentReadOnly,
              );
            }}
          >
            {/* Custom menu = the default composition minus the "Excalidraw links"
                socials group and ToggleTheme (theme is controlled, app is
                dark-only). Providing any MainMenu child replaces the default. */}
            <MainMenu>
              <MainMenu.DefaultItems.LoadScene />
              <MainMenu.DefaultItems.SaveToActiveFile />
              <MainMenu.DefaultItems.Export />
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.DefaultItems.SearchMenu />
              <MainMenu.DefaultItems.Help />
              <MainMenu.DefaultItems.ClearCanvas />
              <MainMenu.Separator />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
            </MainMenu>
          </Excalidraw>
        </div>
      </div>
    </>
  );
}
