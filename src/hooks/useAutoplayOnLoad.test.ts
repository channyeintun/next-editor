import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import type { EditorActorRef } from "../core/src/useNextEditor";
import { useAutoplayOnLoad } from "./useAutoplayOnLoad";

const audioContext = vi.hoisted(() => ({ state: "running" as AudioContextState }));

vi.mock("../core/src/utils/audioContext", () => ({
  resumeSharedAudioContext: () => audioContext,
}));

const recording = (id: string, audio = false) =>
  ({
    id,
    duration: 60_000,
    frames: [],
    ...(audio ? { audioUrl: "narration.ogg" } : {}),
  }) as unknown as Recording;

const editorActorAt = (currentTime: number) =>
  ({
    getSnapshot: () => ({ context: { timeline: { currentTime } } }),
  }) as unknown as EditorActorRef;

type Options = Parameters<typeof useAutoplayOnLoad>[0];

function render(overrides: Partial<Options> = {}) {
  const play = vi.fn<() => void>();
  const initialProps: Options = {
    readOnly: true,
    recordingLoading: false,
    loadError: null,
    currentRecording: recording("lesson"),
    autoplay: true,
    autoplayOverride: false,
    isPlaying: false,
    recordingUrl: "/lessons/lesson.ne",
    editorActor: editorActorAt(0),
    play,
    getLinkedStart: () => 0,
    ...overrides,
  };
  const hook = renderHook((props: Options) => useAutoplayOnLoad(props), { initialProps });
  return { play, initialProps, ...hook };
}

describe("useAutoplayOnLoad", () => {
  beforeEach(() => {
    audioContext.state = "running";
  });

  it("plays a loaded read-only lesson once per recording URL", () => {
    const { play, rerender, initialProps } = render();
    expect(play).toHaveBeenCalledTimes(1);

    // Back to not playing (paused, say): the same load is not autoplayed again.
    rerender({ ...initialProps, currentRecording: recording("lesson") });
    expect(play).toHaveBeenCalledTimes(1);

    rerender({
      ...initialProps,
      currentRecording: recording("next"),
      recordingUrl: "/lessons/next.ne",
    });
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("waits for the load, and never plays an editable or failed one", () => {
    expect(render({ recordingLoading: true }).play).not.toHaveBeenCalled();
    expect(render({ readOnly: false }).play).not.toHaveBeenCalled();
    expect(render({ loadError: "Not found" }).play).not.toHaveBeenCalled();
    expect(render({ currentRecording: null }).play).not.toHaveBeenCalled();
    expect(render({ autoplay: false }).play).not.toHaveBeenCalled();
  });

  it("plays only a lesson still at the moment it was opened at", () => {
    expect(render({ editorActor: editorActorAt(5_000) }).play).not.toHaveBeenCalled();
    expect(
      render({ editorActor: editorActorAt(90_000), getLinkedStart: () => 90_000 }).play,
    ).toHaveBeenCalledTimes(1);
  });

  it("leaves a lesson with narration to the play button until audio may play", () => {
    audioContext.state = "suspended";
    expect(render({ currentRecording: recording("lesson", true) }).play).not.toHaveBeenCalled();
    // Silent lessons, and the playlist's in-session override, need no unlocked audio.
    expect(render().play).toHaveBeenCalledTimes(1);
    expect(
      render({
        currentRecording: recording("lesson", true),
        autoplay: false,
        autoplayOverride: true,
      }).play,
    ).toHaveBeenCalledTimes(1);
  });
});
