import { applyWhiteboardEvent, type WhiteboardEvent } from "../../core/src/whiteboard";
import {
  DEFAULT_PREVIEW_STATE,
  openedSlidePreviewState,
  selectPreviewState,
} from "../../stores/slidesStore";
import { StudioActionError, abortableSleep, waitUntil } from "../async";
import {
  WHITEBOARD_DRAW_FRAME_MS,
  buildWhiteboardElement,
  planWhiteboardDrawFrames,
} from "../whiteboardAssets";
import type { StudioDriver, StudioDriverDeps } from "./index";
import type { StudioPointer } from "./pointer";
import { RECORDER_ASSIGNS_TIMESTAMP } from "./recorderTimestamp";

/**
 * The stage over the editor: showing and closing a slide, and drawing on the
 * whiteboard. Either one covers what the pointer rested on, so it hides it.
 */

export function stageCommands(
  deps: Pick<
    StudioDriverDeps,
    | "slidesStore"
    | "whiteboardStore"
    | "notifySlideEvent"
    | "notifyWhiteboardEvent"
    | "whiteboardAssets"
    | "planSeed"
    | "signal"
  >,
  pointer: Pick<StudioPointer, "hide">,
): Pick<StudioDriver, "showSlide" | "closeSlide" | "applyWhiteboard"> {
  const { signal } = deps;

  return {
    async showSlide({ slideId, maximized }) {
      const slides = deps.slidesStore.getSnapshot().context.slides;
      if (!slides.some((slide) => slide.id === slideId)) {
        throw new StudioActionError(`Slide "${slideId}" is not loaded in the slides store`);
      }
      // The slide takes the stage; the pointer's resting spot under it is stale.
      pointer.hide();

      // Same pair the slides controller performs: record the event, then move
      // the store so the panel renders it (no collaboration in studio renders).
      deps.notifySlideEvent({
        type: "slide_open",
        timestamp: RECORDER_ASSIGNS_TIMESTAMP,
        slideId,
        isMaximized: maximized,
        indexv: 0,
      });
      deps.slidesStore.trigger.setPreviewState({
        previewState: openedSlidePreviewState(slideId, { isMaximized: maximized }),
      });

      await waitUntil(
        () => {
          const previewState = selectPreviewState(deps.slidesStore.getSnapshot().context);
          return previewState.isOpen && previewState.currentSlideId === slideId;
        },
        { timeoutMs: 2_000, signal, description: `slide "${slideId}" to open` },
      );
      return { slideId, maximized };
    },

    async closeSlide() {
      const previewState = selectPreviewState(deps.slidesStore.getSnapshot().context);
      // Unlike the slides controller's closePresentation, this records
      // slide_close even when no slide is open — a known difference, kept on
      // purpose.
      deps.notifySlideEvent({
        type: "slide_close",
        timestamp: RECORDER_ASSIGNS_TIMESTAMP,
        slideId: previewState.currentSlideId ?? undefined,
      });
      deps.slidesStore.trigger.setPreviewState({
        previewState: { ...DEFAULT_PREVIEW_STATE },
      });

      await waitUntil(() => !selectPreviewState(deps.slidesStore.getSnapshot().context).isOpen, {
        timeoutMs: 2_000,
        signal,
        description: "the slide panel to close",
      });
      return {};
    },

    async applyWhiteboard({ open, maximized, upsertIds, drawMs = 0, clear = false }) {
      const assets = upsertIds.map((assetId) => {
        const asset = deps.whiteboardAssets.find((candidate) => candidate.id === assetId);
        if (!asset) {
          throw new StudioActionError(`Whiteboard asset "${assetId}" is not pinned in the plan`);
        }
        return asset;
      });

      // Same pair the whiteboard controller's flush performs: record the delta,
      // then publish the updated scene for the mounted panel — through the same
      // fold replay uses, so the live board and the recording can never disagree
      // about element order. Rebuilding the array by hand appended a re-upserted
      // element at the end while the replay fold kept its original slot, and
      // authored assets carry no `index`, so array order is all Excalidraw has.
      let scene = deps.whiteboardStore.getSnapshot().context.scene;
      const openedAt = scene.isOpen;
      if (open ?? scene.isOpen) {
        // The board takes the stage; the pointer's resting spot under it is stale.
        pointer.hide();
      }
      const publish = (event: WhiteboardEvent) => {
        deps.notifyWhiteboardEvent(event);
        scene = applyWhiteboardEvent(scene, event);
        deps.whiteboardStore.trigger.setScene({ scene });
      };
      const panelFlags = (): Partial<WhiteboardEvent> => ({
        ...(open === undefined || open === scene.isOpen ? {} : { isOpen: open }),
        ...(maximized === undefined || maximized === scene.isMaximized
          ? {}
          : { isMaximized: maximized }),
      });

      // Wiping the board removes everything except what this action is about
      // to draw: applyWhiteboardEvent removes *after* it upserts, so an id in
      // both lists would be deleted instead of redrawn.
      const drawnIds = new Set(upsertIds);
      const wipedIds = clear
        ? scene.elements.map((element) => element.id).filter((id) => !drawnIds.has(id))
        : [];
      // Consumed once, by the first event — the board is empty before the pen
      // moves, and later frames of the same draw must not re-remove anything.
      let pendingWipe = wipedIds;
      const wipe = (): Partial<WhiteboardEvent> => {
        if (pendingWipe.length === 0) return {};
        const removedIds = pendingWipe;
        pendingWipe = [];
        return { removedIds };
      };

      const frames = planWhiteboardDrawFrames(assets.length, drawMs);
      if (frames.length === 0) {
        const upserts = assets.map((asset) => buildWhiteboardElement(asset, deps.planSeed));
        publish({
          timestamp: RECORDER_ASSIGNS_TIMESTAMP,
          ...(upserts.length > 0 ? { upserts } : {}),
          ...wipe(),
          ...panelFlags(),
        });
      } else {
        // A drawn apply is the same delta track at a finer grain: one event per
        // step, each carrying only the element being drawn right then. Replay
        // interpolates between those steps (replayState/whiteboard.ts), so the
        // recorded ~20Hz frames come back as a continuous stroke, and the panel
        // opens on the first frame rather than after the drawing.
        for (const frame of frames) {
          publish({
            timestamp: RECORDER_ASSIGNS_TIMESTAMP,
            upserts: [buildWhiteboardElement(assets[frame.assetIndex], deps.planSeed, frame)],
            ...wipe(),
            ...panelFlags(),
          });
          await abortableSleep(WHITEBOARD_DRAW_FRAME_MS, signal);
        }
      }

      await waitUntil(
        () => {
          const applied = deps.whiteboardStore.getSnapshot().context.scene;
          return (
            (open === undefined || applied.isOpen === open) &&
            assets.every((asset) =>
              applied.elements.some((candidate) => candidate.id === asset.id),
            ) &&
            wipedIds.every((id) => !applied.elements.some((candidate) => candidate.id === id))
          );
        },
        { timeoutMs: 2_000, signal, description: "the whiteboard scene to apply" },
      );
      return {
        upserted: assets.length,
        open: open ?? openedAt,
        frames: frames.length,
        wiped: wipedIds.length,
      };
    },
  };
}
