import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { CaptureUpdateAction, Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AppState, BinaryFiles, NormalizedZoomValue } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import { useWhiteboardContext } from "../contexts/WhiteboardContext";
import { useNextEditorMetadata } from "../hooks/useNextEditorContext";
import type { WhiteboardElementJSON, WhiteboardView } from "../core/src/whiteboard";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import { useWhiteboardStore } from "../contexts/WhiteboardStoreContext";
import { planWhiteboardCanvasView } from "../stores/whiteboardStore";
import { clearTextMeasurements, fitTextElement } from "../utils/whiteboardTextFit";

// Image embeds are out of scope for v1 (binary files aren't recorded into the
// .ne, see whiteboard-plan.md §4) — this also gates paste/drag-drop of images,
// not just the toolbar button (Excalidraw checks it in insertImageElement).
const UI_OPTIONS = { tools: { image: false } };

// Excalidraw mutates the element objects it is handed in place (fractional-index
// sync inside updateScene, and every live edit after playback hands control back).
// The store's elements are the same objects held by `recording.whiteboardEvents`
// and the replay fold cache, so hand Excalidraw per-element copies to keep the
// recorded data pristine. Text is sized to its glyphs on this machine on the way
// in (see whiteboardTextFit), so a stored width that is too narrow never clips it.
function toExcalidrawElements(
  elements: readonly WhiteboardElementJSON[],
): OrderedExcalidrawElement[] {
  return elements.map((element) => {
    const fitted = fitTextElement(element);
    return fitted === element ? { ...element } : fitted;
  }) as unknown as OrderedExcalidrawElement[];
}

// Something being drawn, dragged, resized, rotated, selected by a box or typed:
// replacing the scene now would interrupt it. (Not cursorButton: a right-click
// can leave it "down" with no gesture in progress.)
function isCanvasGestureActive(appState: AppState): boolean {
  return (
    appState.selectedElementsAreBeingDragged ||
    appState.isResizing ||
    appState.isRotating ||
    Boolean(
      appState.newElement ||
      appState.multiElement ||
      appState.resizingElement ||
      appState.selectionElement ||
      appState.editingTextElement ||
      appState.editingLinearElement,
    )
  );
}

const REFIT_RETRY_MS = 250;

/** EditorHeader's whiteboard toggle, which opens the board and takes focus back. */
const WHITEBOARD_OPENER_SELECTOR = '[data-tour="whiteboard"]';

function toExcalidrawView(view: WhiteboardView) {
  return {
    scrollX: view.scrollX,
    scrollY: view.scrollY,
    zoom: { value: view.zoom as NormalizedZoomValue },
  };
}

export default function WhiteboardPanel() {
  const {
    scene,
    sceneUpdateSource,
    isOpen,
    setOpen,
    setMaximized,
    handleExcalidrawChange,
    markCanvasSynced,
  } = useWhiteboardContext();
  const { usesPlaybackModel, isInPlaybackSession } = useNextEditorMetadata();
  const collaboration = useOptionalCollaboration();
  // The viewer's playback view is read without subscribing: a pan fires onChange every frame,
  // and nothing needs to re-render when it is taken over. It is released only when the
  // session ends (isInPlaybackSession), a followed view replaces it (a new scene) or the
  // controller unmounts, each of which re-runs the scene effect below or unmounts the panel.
  const { store } = useWhiteboardStore();
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  // False until a newly mounted canvas sends its first onChange. That first
  // report is the scene it loaded from initialData, not an edit.
  const canvasLoadedRef = useRef(false);
  const contentReadOnly =
    usesPlaybackModel || Boolean(collaboration?.provider && !collaboration.canWrite);
  const [initialView] = useState(
    () =>
      planWhiteboardCanvasView(
        scene.view,
        store.getSnapshot().context.playbackViewerView,
        isInPlaybackSession,
      ).view,
  );
  // The view this canvas was last given (initialData, then each scene update). During a
  // playback session an onChange reporting any other view is the viewer panning or zooming.
  const appliedViewRef = useRef<WhiteboardView | null>(initialView);

  // External state (remote room projection, followed viewport, playback, or a
  // restored store) drives the mounted canvas. A canvas-origin scene is the
  // controller's throttled snapshot of the gesture already in progress; feeding
  // it back through updateScene would rewind that gesture to the last 100 ms
  // checkpoint. Once the viewer has panned or zoomed during a playback session
  // (playing, paused or ended), scenes update only the elements
  // (planWhiteboardCanvasView), so neither a recorded view nor the hand-over to
  // the viewer on pause moves the canvas.
  useEffect(() => {
    if (!apiRef.current || (!usesPlaybackModel && sceneUpdateSource === "canvas")) return;
    const { view, applyView } = planWhiteboardCanvasView(
      scene.view,
      store.getSnapshot().context.playbackViewerView,
      isInPlaybackSession,
    );
    appliedViewRef.current = view;
    apiRef.current.updateScene({
      elements: toExcalidrawElements(scene.elements),
      ...(applyView ? { appState: toExcalidrawView(view) } : {}),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    // updateScene has already tidied the elements (z-order indexes) by the time
    // it returns. The onChange that follows reports this same scene back, and it
    // must not be recorded as an edit. A playing lesson sends no onChange to the
    // controller, so there is nothing to compare while it plays.
    if (!usesPlaybackModel) {
      markCanvasSynced(
        apiRef.current.getSceneElementsIncludingDeleted() as unknown as WhiteboardElementJSON[],
        scene.elements,
      );
    }
  }, [scene, sceneUpdateSource, usesPlaybackModel, isInPlaybackSession, store, markCanvasSynced]);

  // Fit the text the canvas holds, for text that never passed through
  // toExcalidrawElements at its current measurement: text fitted before
  // Excalidraw's font arrived (measured in a fallback font), a reopened canvas
  // given a memoized initialData, a loaded scene or pasted elements. This starts
  // from the canvas's own elements, not the store scene, so nothing drawn since
  // the last push is rewound, and it waits for any gesture to end. The onChange
  // it causes is a fit only, which the controller does not record
  // (withoutTextFit), so an edit still waiting to be saved is kept. A fitted
  // canvas fits again as itself, so the onChange this causes ends the cycle.
  const refitTimerRef = useRef<number | undefined>(undefined);
  const refitCanvasText = () => {
    window.clearTimeout(refitTimerRef.current);
    refitTimerRef.current = undefined;
    const api = apiRef.current;
    if (!api) return;
    if (isCanvasGestureActive(api.getAppState())) {
      refitTimerRef.current = window.setTimeout(refitCanvasText, REFIT_RETRY_MS);
      return;
    }
    const elements = api.getSceneElementsIncludingDeleted() as unknown as WhiteboardElementJSON[];
    const fitted = elements.map((element) => fitTextElement(element));
    if (fitted.every((element, i) => element === elements[i])) return;
    api.updateScene({
      elements: fitted as unknown as OrderedExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };
  // After the canvas reports a change, once (a gesture's many reports share one).
  const scheduleCanvasRefit = () => {
    if (refitTimerRef.current === undefined) {
      refitTimerRef.current = window.setTimeout(refitCanvasText, 0);
    }
  };

  // Excalidraw loads its fonts when the canvas mounts, so text measured before
  // they arrived came out too narrow: measure again and refit once they load.
  useEffect(() => {
    if (!isOpen) return;
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    const onFontsLoaded = () => {
      clearTextMeasurements();
      refitCanvasText();
    };
    let disposed = false;
    fonts?.addEventListener("loadingdone", onFontsLoaded);
    void fonts?.ready.then(() => {
      if (!disposed) onFontsLoaded();
    });
    return () => {
      disposed = true;
      fonts?.removeEventListener("loadingdone", onFontsLoaded);
      window.clearTimeout(refitTimerRef.current);
      refitTimerRef.current = undefined;
    };
  }, [isOpen]);

  // The board is a non-modal dialog: the player bar stays usable above it, so a
  // playback- or presenter-driven open leaves focus on the player alone. Focus
  // that was lost or left in the covered workspace (the opener, or Monaco,
  // blurred when CodeEditor went inert) moves to Close. On close, focus that the
  // removed panel dropped returns to the header's whiteboard button. A passive
  // effect, so the cleanup runs after CodeEditor has dropped `inert`.
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      active.closest("[inert]") ||
      active.closest(WHITEBOARD_OPENER_SELECTOR)
    ) {
      closeButtonRef.current?.focus();
    }
    return () => {
      if (document.activeElement === null || document.activeElement === document.body) {
        document.querySelector<HTMLElement>(WHITEBOARD_OPENER_SELECTOR)?.focus();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const close = () => {
    collaboration?.stopFollowing("local-whiteboard-input");
    setOpen(false);
  };

  return (
    <>
      <div
        className="fixed inset-0 z-90 bg-[#0b0d12]/90 opacity-0 animate-[fade-in_0.2s_ease-out_forwards] motion-reduce:animate-none motion-reduce:opacity-100"
        onClick={close}
      />
      <div
        role="dialog"
        aria-labelledby="whiteboard-title"
        className={`fixed z-100 flex flex-col overflow-hidden bg-slate-900 shadow-2xl transition-[inset,border-radius] motion-reduce:transition-none ${
          scene.isMaximized
            ? "inset-0 rounded-none"
            : "top-[5%] left-[5%] right-[5%] bottom-[5%] rounded-2xl"
        }`}
      >
        {/* Escape is handled here only: on the canvas it belongs to Excalidraw
            (cancel a stroke, leave text editing, deselect). */}
        <div
          className="flex items-center justify-between px-4 py-2 bg-[#11141c] border-b border-white/10 shrink-0"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <h2
            id="whiteboard-title"
            className="text-xs font-bold text-slate-400 uppercase tracking-wider"
          >
            Whiteboard
          </h2>
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
              ref={closeButtonRef}
              type="button"
              aria-label="Close whiteboard"
              onClick={close}
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
              // Excalidraw hands over a new API each time the canvas mounts
              // (the board was closed and opened again).
              if (apiRef.current !== api) canvasLoadedRef.current = false;
              apiRef.current = api;
            }}
            theme="dark"
            viewModeEnabled={contentReadOnly}
            UIOptions={UI_OPTIONS}
            initialData={{
              elements: toExcalidrawElements(scene.elements),
              appState: { ...toExcalidrawView(initialView), zenModeEnabled: true },
            }}
            onChange={(
              elements: readonly OrderedExcalidrawElement[],
              appState: AppState,
              _files: BinaryFiles,
            ) => {
              const view = {
                scrollX: appState.scrollX,
                scrollY: appState.scrollY,
                zoom: appState.zoom.value,
              };
              const isLoadReport = !canvasLoadedRef.current;
              canvasLoadedRef.current = true;
              scheduleCanvasRefit();
              if (isInPlaybackSession) {
                store.trigger.observePlaybackCanvasView({
                  view,
                  appliedView: appliedViewRef.current,
                });
              } else {
                // Outside a session the canvas's own view is the baseline: a pan made
                // before PLAY (a canvas-origin scene the effect skips) must not read as
                // a takeover when the first in-session onChange, fired by Excalidraw's
                // commit before the scene effect runs, still reports that pan.
                appliedViewRef.current = view;
              }
              if (usesPlaybackModel) {
                // View mode leaves drag/scroll panning, wheel and trackpad zoom, and touch
                // pinch to the viewer. While the lesson plays their view stays viewer-only:
                // it is never written to the scene or the recording, and a playback canvas
                // has no edits to capture. Paused or ended, the canvas is the viewer's to
                // edit, so it goes through the live path below as before; the machine
                // records whiteboard events only while recording.
                return;
              }
              if (isLoadReport) {
                // Loading tidies the scene the same way updateScene does (see
                // markCanvasSynced), so it is the baseline, not an edit.
                markCanvasSynced(elements as unknown as WhiteboardElementJSON[]);
                return;
              }
              handleExcalidrawChange(
                elements as unknown as WhiteboardElementJSON[],
                view,
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
