import { applyWhiteboardEvent, type WhiteboardEvent } from "../../core/src/whiteboard";
import {
  DEFAULT_PREVIEW_STATE,
  openedSlidePreviewState,
  selectPreviewState,
} from "../../stores/slidesStore";
import { StudioActionError, abortableSleep, waitUntil } from "../async";
import type { StudioWhiteboardAsset } from "../plan";
import { resolveSlideSurface } from "../targets";
import {
  WHITEBOARD_DRAW_FRAME_MS,
  buildWhiteboardElement,
  planWhiteboardDrawFrames,
} from "../whiteboardAssets";
import { penDrawProgress, penDrawsApply } from "../whiteboardPen";
import type { StudioDriver, StudioDriverDeps } from "./index";
import { isCoveredAt, pointAndRest, roundPoint, type StudioPointer } from "./pointer";
import { RECORDER_ASSIGNS_TIMESTAMP } from "./recorderTimestamp";
import { createWhiteboardPen, resolveBoardSurface } from "./whiteboardPen";

/**
 * The stage over the editor: showing and closing a slide, drawing on the
 * whiteboard, and pointing at either. A slide or a board that opens covers
 * what the pointer rested on, so it hides it; one that closes takes the
 * pointer resting on it along.
 */

const hasSize = (element: Element | null): element is Element => {
  const rect = element?.getBoundingClientRect();
  return !!rect && rect.width > 0 && rect.height > 0;
};

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
  pointer: StudioPointer,
): Pick<
  StudioDriver,
  "showSlide" | "closeSlide" | "pointSlide" | "applyWhiteboard" | "pointWhiteboard"
> {
  const { signal } = deps;
  const pen = createWhiteboardPen(deps, pointer);

  const requireAsset = (assetId: string): StudioWhiteboardAsset => {
    const asset = deps.whiteboardAssets.find((candidate) => candidate.id === assetId);
    if (!asset) {
      throw new StudioActionError(`Whiteboard asset "${assetId}" is not pinned in the plan`);
    }
    return asset;
  };

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
      // A pointer resting on the slide leaves with it.
      pointer.hideOver(resolveSlideSurface());
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

    async pointSlide({ target, durationMs, timeoutMs }) {
      // The slide's box is on screen a frame or two after slide.show returns.
      await waitUntil(
        () =>
          selectPreviewState(deps.slidesStore.getSnapshot().context).isOpen &&
          hasSize(resolveSlideSurface()),
        { timeoutMs, signal, description: "a slide on screen to point at" },
      );
      const surface = resolveSlideSurface();
      if (!hasSize(surface)) {
        throw new StudioActionError("No slide is on screen to point at");
      }
      // A deck page is scaled to fill this box, so a fraction of the box is the
      // same spot on the page at any size — here, and on the viewer's screen.
      const aim = () => {
        const rect = surface.getBoundingClientRect();
        return {
          x: rect.left + target.x * rect.width,
          y: rect.top + target.y * rect.height,
        };
      };
      if (isCoveredAt(roundPoint(aim()), surface)) {
        throw new StudioActionError(
          `The slide is covered at (${target.x}, ${target.y}) — is the whiteboard open over it?`,
        );
      }
      const { travelMs } = await pointAndRest(pointer, {
        aim,
        surface,
        durationMs,
        signal,
        exact: true,
      });
      return { x: target.x, y: target.y, travelMs };
    },

    async pointWhiteboard({ target, durationMs, timeoutMs }) {
      const asset = requireAsset(target.assetId);
      await waitUntil(
        () => {
          const scene = deps.whiteboardStore.getSnapshot().context.scene;
          return (
            scene.isOpen &&
            scene.elements.some((element) => element.id === asset.id && !element.isDeleted) &&
            hasSize(resolveBoardSurface())
          );
        },
        {
          timeoutMs,
          signal,
          description: `whiteboard asset "${asset.id}" on the open board`,
        },
      );
      const surface = resolveBoardSurface();
      if (!hasSize(surface)) {
        throw new StudioActionError("The whiteboard is not on screen to point at");
      }
      const aim = () => pen.pointAim(surface, asset);
      if (isCoveredAt(roundPoint(aim()), surface)) {
        throw new StudioActionError(`Whiteboard asset "${asset.id}" is covered on screen`);
      }
      const { travelMs } = await pointAndRest(pointer, {
        aim,
        surface,
        durationMs,
        signal,
        exact: true,
      });
      return { assetId: asset.id, travelMs };
    },

    async applyWhiteboard({ open, maximized, upsertIds, drawMs = 0, clear = false }) {
      const assets = upsertIds.map(requireAsset);

      // Same pair the whiteboard controller's flush performs: record the delta,
      // then publish the updated scene for the mounted panel — through the same
      // fold replay uses, so the live board and the recording can never disagree
      // about element order. Rebuilding the array by hand appended a re-upserted
      // element at the end while the replay fold kept its original slot, and
      // authored assets carry no `index`, so array order is all Excalidraw has.
      let scene = deps.whiteboardStore.getSnapshot().context.scene;
      const openedAt = scene.isOpen;
      const frames = planWhiteboardDrawFrames(assets.length, drawMs);
      const stepsPerAsset = assets.length > 0 ? frames.length / assets.length : 0;
      // Only a board that is being drawn slowly enough to follow gets the pen.
      const penDraws = (open ?? scene.isOpen) && penDrawsApply(stepsPerAsset);

      if ((open ?? scene.isOpen) !== scene.isOpen) {
        // The board takes the stage, and the pointer's resting spot under it is
        // stale — or it leaves the stage, and takes a pointer resting on it along.
        pointer.hide();
      } else if (scene.isOpen && !penDraws) {
        // The board changes without the pen: a pointer still resting on what
        // was drawn or pointed at before would be parked on old news.
        pointer.hideOver(resolveBoardSurface());
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
        let leadSteps = 0;
        for (const frame of frames) {
          const asset = assets[frame.assetIndex];
          // `version` counts an asset's steps from 1.
          const step = frame.version;
          if (step === 1) {
            leadSteps = penDraws ? pen.leadSteps() : 0;
          }
          const progress = penDraws
            ? penDrawProgress(asset, step, stepsPerAsset, leadSteps)
            : frame.progress;
          if (progress === null) {
            // The pen is on its way to this asset. Nothing of it is drawn yet,
            // but a wipe or the board opening must not wait for the pen.
            const flags = { ...wipe(), ...panelFlags() };
            if (Object.keys(flags).length > 0) {
              publish({ timestamp: RECORDER_ASSIGNS_TIMESTAMP, ...flags });
            }
          } else {
            publish({
              timestamp: RECORDER_ASSIGNS_TIMESTAMP,
              upserts: [
                buildWhiteboardElement(asset, deps.planSeed, { progress, version: frame.version }),
              ],
              ...wipe(),
              ...panelFlags(),
            });
            if (penDraws) {
              pen.draw(asset, progress, { ends: progress >= 1 });
            }
          }
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
        ...(penDraws ? { pen: true } : {}),
      };
    },
  };
}
