import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { CaptureUpdateAction, Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AppState, BinaryFiles, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import { useWhiteboardContext } from "../contexts/WhiteboardContext";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import type { WhiteboardElementJSON } from "../core/src/whiteboard";

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
  const { scene, isOpen, setOpen, handleExcalidrawChange } = useWhiteboardContext();
  const { usesPlaybackModel } = useNextEditorMetadata();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  // Replay drives the board through the store; push its scene into Excalidraw.
  // Live drawing never reaches here — while `usesPlaybackModel` is false, Excalidraw
  // is already the source of truth for its own onChange output, so pushing it back
  // would be a redundant, self-triggering round trip.
  useEffect(() => {
    if (!apiRef.current || !usesPlaybackModel) return;
    apiRef.current.updateScene({
      elements: toExcalidrawElements(scene.elements),
      appState: {
        scrollX: scene.view.scrollX,
        scrollY: scene.view.scrollY,
        zoom: { value: scene.view.zoom as NormalizedZoomValue },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [scene, usesPlaybackModel]);

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-90 bg-[#0b0d12]/62 backdrop-blur-md opacity-0 animate-[fade-in_0.2s_ease-out_forwards] motion-reduce:animate-none motion-reduce:opacity-100"
        onClick={() => setOpen(false)}
      />
      <div className="fixed top-[5%] left-[5%] right-[5%] bottom-[5%] z-100 bg-slate-900 rounded-2xl overflow-hidden flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-2 bg-[#11141c] border-b border-white/10 shrink-0">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            Whiteboard
          </span>
          <button
            type="button"
            aria-label="Close whiteboard"
            onClick={() => setOpen(false)}
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>
        {/* The arbitrary variant hides the library sidebar toggle — the library
            has no recording semantics and Excalidraw exposes no UIOptions flag
            for it. Zen mode is a default (via initialData, so the presenter can
            still toggle it), not the controlled `zenModeEnabled` prop. */}
        <div className="relative flex-1 [&_.default-sidebar-trigger]:hidden">
          <Excalidraw
            excalidrawAPI={(api) => {
              apiRef.current = api;
            }}
            theme="dark"
            viewModeEnabled={usesPlaybackModel}
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
                usesPlaybackModel,
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
