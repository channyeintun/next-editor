import { describe, expect, it } from "vite-plus/test";
import type { WhiteboardView } from "../core/src/whiteboard";
import { createWhiteboardStore, planWhiteboardCanvasView } from "./whiteboardStore";

const recorded: WhiteboardView = { scrollX: 0, scrollY: 0, zoom: 1 };
const pinched: WhiteboardView = { scrollX: -120, scrollY: 40, zoom: 2.5 };

describe("whiteboard playback viewer view", () => {
  it("follows the recorded view until the viewer pans or zooms", () => {
    expect(planWhiteboardCanvasView(recorded, null, true)).toEqual({
      view: recorded,
      applyView: true,
    });
    const nextRecorded = { scrollX: 300, scrollY: 0, zoom: 1 };
    expect(planWhiteboardCanvasView(nextRecorded, pinched, true)).toEqual({
      view: pinched,
      applyView: false,
    });
  });

  it("never lets a playback viewer view steer live editing after the session", () => {
    expect(planWhiteboardCanvasView(recorded, pinched, false)).toEqual({
      view: recorded,
      applyView: true,
    });
  });

  it("treats the onChange that echoes an applied view as ours, not the viewer's", () => {
    const store = createWhiteboardStore();

    store.trigger.observePlaybackCanvasView({ view: { ...recorded }, appliedView: recorded });
    expect(store.getSnapshot().context.playbackViewerView).toBeNull();

    // Before the canvas has been given any view there is nothing to tell an echo apart from.
    store.trigger.observePlaybackCanvasView({ view: pinched, appliedView: null });
    expect(store.getSnapshot().context.playbackViewerView).toBeNull();

    store.trigger.observePlaybackCanvasView({ view: pinched, appliedView: recorded });
    expect(store.getSnapshot().context.playbackViewerView).toEqual(pinched);
  });

  it("tracks every later view change once the viewer owns the viewport", () => {
    const store = createWhiteboardStore();
    store.trigger.observePlaybackCanvasView({ view: pinched, appliedView: recorded });

    // Panning back onto the view the panel last applied is still the viewer's view.
    store.trigger.observePlaybackCanvasView({ view: { ...recorded }, appliedView: recorded });
    expect(store.getSnapshot().context.playbackViewerView).toEqual(recorded);
  });

  it("follows the viewer's view through a pause, where the session goes on", () => {
    expect(planWhiteboardCanvasView(recorded, pinched, true)).toEqual({
      view: pinched,
      applyView: false,
    });
  });

  it("keeps the viewer view out of the scene that recorded data shares", () => {
    const store = createWhiteboardStore();
    const scene = store.getSnapshot().context.scene;

    store.trigger.observePlaybackCanvasView({ view: pinched, appliedView: recorded });

    expect(store.getSnapshot().context.scene).toBe(scene);
    expect(store.getSnapshot().context.scene.view).toEqual(recorded);

    // Recorded scenes keep arriving without dropping the viewer's view.
    const nextScene = {
      ...scene,
      elements: [{ id: "stroke", version: 1, versionNonce: 1, isDeleted: false }],
    };
    store.trigger.setScene({ scene: nextScene });
    expect(store.getSnapshot().context).toMatchObject({
      scene: nextScene,
      playbackViewerView: pinched,
    });
  });

  it("returns the canvas to the recorded view once released", () => {
    const store = createWhiteboardStore();
    store.trigger.observePlaybackCanvasView({ view: pinched, appliedView: recorded });

    store.trigger.releasePlaybackViewerView();

    const { playbackViewerView, scene } = store.getSnapshot().context;
    expect(playbackViewerView).toBeNull();
    expect(planWhiteboardCanvasView(scene.view, playbackViewerView, true)).toEqual({
      view: recorded,
      applyView: true,
    });
  });
});
