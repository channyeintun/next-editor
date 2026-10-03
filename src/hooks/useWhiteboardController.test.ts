import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  applyWhiteboardEvent,
  EMPTY_WHITEBOARD_SCENE,
  type WhiteboardEvent,
} from "../core/src/whiteboard";
import { createWhiteboardStore } from "../stores/whiteboardStore";
import {
  discardPendingWhiteboardChange,
  flushPendingWhiteboardChange,
  useWhiteboardController,
} from "./useWhiteboardController";

function element(id: string, version = 1) {
  return {
    id,
    version,
    versionNonce: version * 10,
    isDeleted: false,
    index: id === "remote" ? "a1" : "a0",
  };
}

describe("useWhiteboardController", () => {
  afterEach(() => vi.useRealTimers());

  it("flushes pending visible changes synchronously at a room boundary", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result } = renderHook(() => useWhiteboardController({ store, onWhiteboardEvent }));

    act(() => {
      result.current.handleExcalidrawChange(
        [element("boundary")],
        { scrollX: 3, scrollY: 4, zoom: 1.25 },
        false,
      );
      flushPendingWhiteboardChange(store);
    });

    expect(onWhiteboardEvent).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().context.scene).toMatchObject({
      elements: [expect.objectContaining({ id: "boundary" })],
      view: { scrollX: 3, scrollY: 4, zoom: 1.25 },
    });
    vi.advanceTimersByTime(100);
    expect(onWhiteboardEvent).toHaveBeenCalledTimes(1);
  });

  it("discards a pending delta when its room or playback scope is replaced", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result, rerender } = renderHook(
      ({ scopeKey }) => useWhiteboardController({ store, onWhiteboardEvent, scopeKey }),
      { initialProps: { scopeKey: "standalone" } },
    );

    act(() => {
      result.current.handleExcalidrawChange(
        [element("stale")],
        { scrollX: 0, scrollY: 0, zoom: 1 },
        false,
      );
    });
    act(() => {
      rerender({ scopeKey: "room" });
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onWhiteboardEvent).not.toHaveBeenCalled();
    expect(store.getSnapshot().context.scene.elements).toEqual([]);

    act(() => {
      result.current.handleExcalidrawChange(
        [element("discarded")],
        { scrollX: 0, scrollY: 0, zoom: 1 },
        false,
      );
      discardPendingWhiteboardChange(store);
      vi.advanceTimersByTime(100);
    });
    expect(onWhiteboardEvent).not.toHaveBeenCalled();
  });

  it("applies and records local maximize state without changing board content", () => {
    const store = createWhiteboardStore();
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result } = renderHook(() => useWhiteboardController({ store, onWhiteboardEvent }));
    const elements = store.getSnapshot().context.scene.elements;

    act(() => result.current.setMaximized(true));

    expect(store.getSnapshot().context.scene).toMatchObject({
      elements,
      isMaximized: true,
    });
    expect(store.getSnapshot().context.scene.elements).toBe(elements);
    expect(onWhiteboardEvent).toHaveBeenCalledWith({
      timestamp: expect.any(Number),
      isMaximized: true,
    });
  });

  it("clones mutable local upserts before recording and store projection", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result } = renderHook(() => useWhiteboardController({ store, onWhiteboardEvent }));
    const live = { ...element("stroke"), points: [[0, 0]] };

    act(() => {
      result.current.handleExcalidrawChange([live], { scrollX: 0, scrollY: 0, zoom: 1 }, false);
      vi.advanceTimersByTime(100);
    });
    live.points.push([1, 1]);

    const event = onWhiteboardEvent.mock.calls[0]?.[0];
    expect(event.upserts?.[0]?.points).toEqual([[0, 0]]);
    expect(store.getSnapshot().context.scene.elements[0]).not.toBe(live);
    expect(store.getSnapshot().context.sceneUpdateSource).toBe("canvas");

    act(() => result.current.applyView({ scrollX: 10, scrollY: 20, zoom: 2 }, false));
    expect(store.getSnapshot().context.sceneUpdateSource).toBe("external");
  });

  // The next-editor-intro-mm lesson recorded 416 of these: Excalidraw adding an
  // `index` (and a version bump) to a scene the studio pushed in, often one 50 ms
  // draw step behind the store. Replayed, each piece jumped back a step and its
  // label flashed behind the filled box around it.
  it("does not record the canvas reporting back a scene it was given", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result } = renderHook(() => useWhiteboardController({ store, onWhiteboardEvent }));
    const view = { scrollX: 0, scrollY: 0, zoom: 1 };
    // Authored studio steps: no `index`, the box grows.
    const step = (width: number, version: number) => ({
      id: "box",
      version,
      versionNonce: 5,
      isDeleted: false,
      updated: 1,
      width,
    });
    // What Excalidraw makes of a step it is given.
    const tidied = (width: number, version: number) => ({
      ...step(width, version),
      version: version + 1,
      versionNonce: 900 + version,
      updated: 1791046571329,
      index: "a0",
    });

    act(() => {
      const given = [step(10, 1)];
      store.trigger.setScene({ scene: { ...store.getSnapshot().context.scene, elements: given } });
      result.current.markCanvasSynced([tidied(10, 1)], given);
      result.current.handleExcalidrawChange([tidied(10, 1)], view, false);
      // The next step reaches the store before the canvas reports again.
      store.trigger.setScene({
        scene: { ...store.getSnapshot().context.scene, elements: [step(20, 2)] },
      });
      vi.advanceTimersByTime(100);
    });

    expect(onWhiteboardEvent).not.toHaveBeenCalled();
    expect(store.getSnapshot().context.scene.elements).toEqual([step(20, 2)]);
  });

  it("records a real edit of an authored board with every element's canvas index", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result } = renderHook(() => useWhiteboardController({ store, onWhiteboardEvent }));
    // A label drawn over a box, both authored, so neither has an index.
    const box = { id: "box", version: 1, versionNonce: 5, isDeleted: false };
    const label = { id: "label", version: 1, versionNonce: 6, isDeleted: false };
    const given = [box, label];
    const canvas = [
      { ...box, version: 2, versionNonce: 50, index: "a0" },
      { ...label, version: 2, versionNonce: 60, index: "a1" },
    ];

    act(() => {
      store.trigger.setScene({ scene: { ...store.getSnapshot().context.scene, elements: given } });
      result.current.markCanvasSynced(canvas, given);
      result.current.handleExcalidrawChange(
        [{ ...canvas[0]!, version: 3, versionNonce: 51, x: 40 }, canvas[1]!],
        { scrollX: 0, scrollY: 0, zoom: 1 },
        false,
      );
      vi.advanceTimersByTime(100);
    });

    // Recording only the moved box would index it while the label has none, and
    // replay sorts unindexed elements first, so the box would cover the label.
    const event = onWhiteboardEvent.mock.calls[0]![0];
    expect(event.upserts).toContainEqual(expect.objectContaining({ id: "box", x: 40 }));
    const replayed = applyWhiteboardEvent({ ...EMPTY_WHITEBOARD_SCENE, elements: given }, event);
    expect(replayed.elements.map(({ id }) => id)).toEqual(["box", "label"]);
    expect(store.getSnapshot().context.scene.elements.map(({ id }) => id)).toEqual([
      "box",
      "label",
    ]);
  });

  it("rebases a pending local stroke over a remote element that arrived during capture", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    store.trigger.setScene({
      scene: {
        ...store.getSnapshot().context.scene,
        elements: [element("local")],
      },
    });
    const { result } = renderHook(() => useWhiteboardController({ store }));

    act(() => {
      result.current.handleExcalidrawChange(
        [element("local", 2)],
        { scrollX: 0, scrollY: 0, zoom: 1 },
        false,
      );
      store.trigger.setScene({
        scene: {
          ...store.getSnapshot().context.scene,
          elements: [element("local"), element("remote")],
        },
      });
      vi.advanceTimersByTime(100);
    });

    expect(store.getSnapshot().context.scene.elements.map(({ id }) => id)).toEqual([
      "local",
      "remote",
    ]);
    expect(store.getSnapshot().context.scene.elements[0]?.version).toBe(2);
  });

  it("keeps viewer content read-only while retaining local pan and zoom", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    store.trigger.setScene({
      scene: { ...store.getSnapshot().context.scene, elements: [element("shared")] },
    });
    const onWhiteboardEvent = vi.fn<(event: WhiteboardEvent) => boolean | void>();
    const { result } = renderHook(() => useWhiteboardController({ store, onWhiteboardEvent }));

    act(() => {
      result.current.handleExcalidrawChange(
        [element("malicious-local")],
        { scrollX: 25, scrollY: -10, zoom: 2 },
        true,
      );
      vi.advanceTimersByTime(100);
    });

    expect(store.getSnapshot().context.scene).toMatchObject({
      elements: [expect.objectContaining({ id: "shared" })],
      view: { scrollX: 25, scrollY: -10, zoom: 2 },
    });
    expect(onWhiteboardEvent).toHaveBeenCalledWith({
      timestamp: expect.any(Number),
      view: { scrollX: 25, scrollY: -10, zoom: 2 },
    });
  });

  it("rolls back a local content delta rejected by the collaboration boundary", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    store.trigger.setScene({
      scene: { ...store.getSnapshot().context.scene, elements: [element("shared")] },
    });
    const { result } = renderHook(() =>
      useWhiteboardController({ store, onWhiteboardEvent: () => false }),
    );

    act(() => {
      result.current.handleExcalidrawChange(
        [element("local")],
        { scrollX: 0, scrollY: 0, zoom: 1 },
        false,
      );
      vi.advanceTimersByTime(100);
    });

    expect(store.getSnapshot().context.scene.elements).toEqual([element("shared")]);
  });

  // WhiteboardPanel pushes only "external" scenes into Excalidraw; a "canvas" scene is the
  // gesture already on screen. A refused change is not on screen as far as the room goes.
  it("hands a rejected delta's rollback to the canvas and keeps the local pan and zoom", () => {
    vi.useFakeTimers();
    const store = createWhiteboardStore();
    store.trigger.setScene({
      scene: { ...store.getSnapshot().context.scene, elements: [element("shared")] },
    });
    const { result } = renderHook(() =>
      useWhiteboardController({ store, onWhiteboardEvent: () => false }),
    );

    act(() => {
      result.current.handleExcalidrawChange(
        [element("shared"), element("refused-stroke")],
        { scrollX: 40, scrollY: 0, zoom: 1.5 },
        false,
      );
      vi.advanceTimersByTime(100);
    });

    const { scene, sceneUpdateSource } = store.getSnapshot().context;
    expect(scene.elements).toEqual([element("shared")]);
    expect(scene.view).toEqual({ scrollX: 40, scrollY: 0, zoom: 1.5 });
    expect(sceneUpdateSource).toBe("external");
  });

  it("lets a followed participant's view replace a playback viewer view", () => {
    const store = createWhiteboardStore();
    const { result } = renderHook(() =>
      useWhiteboardController({ store, playbackKey: "lesson-a" }),
    );
    act(() =>
      store.trigger.observePlaybackCanvasView({
        view: { scrollX: -80, scrollY: 30, zoom: 2 },
        appliedView: { scrollX: 0, scrollY: 0, zoom: 1 },
      }),
    );

    act(() => result.current.applyView({ scrollX: 20, scrollY: -10, zoom: 1.5 }, false));

    expect(store.getSnapshot().context).toMatchObject({
      playbackViewerView: null,
      scene: { view: { scrollX: 20, scrollY: -10, zoom: 1.5 } },
    });
  });

  it("keeps a playback viewer view for one recording's playback only", () => {
    const store = createWhiteboardStore();
    const pinched = { scrollX: -80, scrollY: 30, zoom: 2 };
    const takeOver = () =>
      store.trigger.observePlaybackCanvasView({
        view: pinched,
        appliedView: { scrollX: 0, scrollY: 0, zoom: 1 },
      });
    const { rerender, unmount } = renderHook(
      ({ playbackKey }: { playbackKey: string | null }) =>
        useWhiteboardController({ store, playbackKey }),
      { initialProps: { playbackKey: "lesson-a" as string | null } },
    );

    act(takeOver);
    rerender({ playbackKey: "lesson-a" });
    expect(store.getSnapshot().context.playbackViewerView).toEqual(pinched);

    // A different recording loads.
    rerender({ playbackKey: "lesson-b" });
    expect(store.getSnapshot().context.playbackViewerView).toBeNull();

    // The playback session ends (STOP or UNLOAD).
    act(takeOver);
    rerender({ playbackKey: null });
    expect(store.getSnapshot().context.playbackViewerView).toBeNull();

    rerender({ playbackKey: "lesson-b" });
    act(takeOver);
    unmount();
    expect(store.getSnapshot().context.playbackViewerView).toBeNull();
  });
});
