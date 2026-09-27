import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useTimelineSyncedVideo } from "./useTimelineSyncedVideo";
import type { MediaSpan } from "../../core/src/utils/mediaSpans";

const editor = vi.hoisted(() => {
  const timeline = { currentTime: 0, speed: 1 };
  const state = { playing: false };
  const listeners = new Set<() => void>();
  const actor = {
    getSnapshot: () => ({ matches: () => state.playing, context: { timeline } }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
  };
  return { timeline, state, listeners, actor };
});

vi.mock("../../contexts/NextEditorActorContext", () => ({
  NextEditorActorContext: {
    useActorRef: () => editor.actor,
    useSelector: (selector: (snapshot: unknown) => unknown) => selector(editor.actor.getSnapshot()),
  },
}));

function fakeVideo() {
  const handlers = new Map<string, () => void>();
  return {
    srcObject: {} as MediaStream | null,
    currentTime: 0,
    playbackRate: 1,
    pause: vi.fn<() => void>(),
    play: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    addEventListener: (type: string, handler: () => void) => handlers.set(type, handler),
    removeEventListener: (type: string) => handlers.delete(type),
    handlers,
  };
}

const syncVideo = (
  video: ReturnType<typeof fakeVideo>,
  options: { cameraCuts?: MediaSpan[]; cameraStartOffsetMs?: number } = {},
) =>
  renderHook(() =>
    useTimelineSyncedVideo({ current: video as unknown as HTMLVideoElement }, "blob:camera", {
      cameraCuts: options.cameraCuts,
      cameraStartOffsetMs: options.cameraStartOffsetMs ?? 0,
      isVisible: true,
      isMinimized: false,
    }),
  );

let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn<(id: number) => void>());
});

afterEach(() => {
  vi.unstubAllGlobals();
  editor.listeners.clear();
  editor.timeline.currentTime = 0;
  editor.timeline.speed = 1;
  editor.state.playing = false;
});

const runNextFrame = () => {
  const frame = frames.shift();
  frame?.(0);
};

describe("useTimelineSyncedVideo", () => {
  it("holds the paused frame on the timeline, following seeks", () => {
    editor.timeline.currentTime = 10_000;
    editor.timeline.speed = 1.5;
    const video = fakeVideo();
    const { unmount } = syncVideo(video, { cameraStartOffsetMs: 1_000 });

    // The camera started a second after the recording.
    expect(video.srcObject).toBeNull();
    expect(video.pause).toHaveBeenCalled();
    expect(video.playbackRate).toBe(1.5);
    expect(video.currentTime).toBe(9);

    // Within the drift allowance, the frame stays put.
    editor.timeline.currentTime = 10_100;
    act(() => editor.listeners.forEach((listener) => listener()));
    expect(video.currentTime).toBe(9);

    editor.timeline.currentTime = 20_000;
    act(() => editor.listeners.forEach((listener) => listener()));
    expect(video.currentTime).toBe(19);

    unmount();
    expect(editor.listeners.size).toBe(0);
  });

  it("steps over what a retake cut from the camera", () => {
    editor.timeline.currentTime = 10_000;
    const video = fakeVideo();
    syncVideo(video, { cameraCuts: [{ start: 2_000, end: 5_000 }] });

    expect(video.currentTime).toBe(13);
  });

  it("plays along with the timeline, and re-anchors once frames flow", () => {
    editor.state.playing = true;
    editor.timeline.currentTime = 4_000;
    const video = fakeVideo();
    const { unmount } = syncVideo(video);

    expect(video.play).toHaveBeenCalled();
    expect(video.currentTime).toBe(4);

    editor.timeline.currentTime = 4_200;
    runNextFrame();
    expect(video.currentTime).toBe(4);
    editor.timeline.currentTime = 5_000;
    runNextFrame();
    expect(video.currentTime).toBe(5);

    // The first frame lands late; the `playing` event pulls the video onto the timeline.
    editor.timeline.currentTime = 5_100;
    video.handlers.get("playing")?.();
    expect(video.currentTime).toBeCloseTo(5.1);

    unmount();
    expect(video.handlers.has("playing")).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });
});
