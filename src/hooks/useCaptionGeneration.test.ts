import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { describeCaptionGeneration, useCaptionGeneration } from "./useCaptionGeneration";
import type { CaptionCue, CaptionTrack, Recording } from "../core/src";
import type { CaptionGenerationProgress } from "../captions/generateCaptions";

type GenerateCaptions = (
  recording: Recording,
  audio: Blob,
  options: {
    onProgress?: (progress: CaptionGenerationProgress) => void;
    signal?: AbortSignal;
  },
) => Promise<{ language: string; cues: CaptionCue[] }>;

const whisper = vi.hoisted(() => ({ generateCaptions: vi.fn<GenerateCaptions>() }));
const actions = vi.hoisted(() => ({
  addCaptionTrack: vi.fn<(recordingId: string, track: CaptionTrack) => void>(),
}));
const captionStore = vi.hoisted(() => ({
  selectTrack: vi.fn<(event: { trackId: string; language: string }) => void>(),
  setEnabled: vi.fn<(event: { enabled: boolean }) => void>(),
}));

vi.mock("../captions/generateCaptions", () => whisper);
vi.mock("./useNextEditorContext", () => ({ useNextEditorActions: () => actions }));
vi.mock("./useCaptionStore", () => ({ useCaptionStoreTrigger: () => captionStore }));

const narration = new Blob(["narration"], { type: "audio/webm" });
const lesson = { id: "lesson", audioBlob: narration } as unknown as Recording;
const hello: CaptionCue[] = [{ start: 0, end: 1_000, text: "Hello" }];

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("useCaptionGeneration", () => {
  it("transcribes the narration, reporting progress, and shows the captions as a track", async () => {
    let finish: () => void = () => {};
    whisper.generateCaptions.mockImplementation((_recording, _audio, { onProgress }) => {
      onProgress?.({ phase: "model", fraction: 0.4 });
      return new Promise((resolve) => {
        finish = () => resolve({ language: "de", cues: hello });
      });
    });
    const { result } = renderHook(() => useCaptionGeneration());

    let job: Promise<void> = Promise.resolve();
    act(() => {
      job = result.current.start(lesson);
    });
    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "running",
        progress: { phase: "model", fraction: 0.4 },
      }),
    );
    expect(describeCaptionGeneration(result.current.state)).toBe(
      "Downloading the speech model… 40%",
    );
    expect(whisper.generateCaptions).toHaveBeenCalledWith(lesson, narration, expect.anything());

    await act(async () => {
      finish();
      await job;
    });
    expect(actions.addCaptionTrack).toHaveBeenCalledWith("lesson", {
      id: expect.stringMatching(/^auto-de-\d+$/),
      language: "de",
      label: "DE (auto)",
      cues: hello,
      default: true,
    });
    expect(captionStore.selectTrack).toHaveBeenCalledWith({
      trackId: actions.addCaptionTrack.mock.calls[0][1].id,
      language: "de",
    });
    expect(captionStore.setEnabled).toHaveBeenCalledWith({ enabled: true });
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("adds a track beside the lesson's own captions without making it the default", async () => {
    whisper.generateCaptions.mockResolvedValue({ language: "en", cues: hello });
    const captioned = { ...lesson, captions: [{ id: "en", language: "en", cues: [] }] };
    const { result } = renderHook(() => useCaptionGeneration());

    await act(() => result.current.start(captioned as Recording));
    expect(actions.addCaptionTrack).toHaveBeenCalledWith(
      "lesson",
      expect.objectContaining({ default: false }),
    );
  });

  it("says so when the narration has no speech", async () => {
    whisper.generateCaptions.mockResolvedValue({ language: "en", cues: [] });
    const { result } = renderHook(() => useCaptionGeneration());

    await act(() => result.current.start(lesson));
    expect(result.current.state).toEqual({
      status: "failed",
      message: "No speech was found in the narration.",
    });
    expect(actions.addCaptionTrack).not.toHaveBeenCalled();
  });

  it("says why when captioning fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    whisper.generateCaptions.mockRejectedValue(new Error("The model could not be loaded."));
    const { result } = renderHook(() => useCaptionGeneration());

    await act(() => result.current.start(lesson));
    expect(result.current.state).toEqual({
      status: "failed",
      message: "The model could not be loaded.",
    });
  });

  it("says so when a linked narration cannot be fetched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const linked = { id: "lesson", audioUrl: "https://example.com/lesson.ogg" } as Recording;
    const { result } = renderHook(() => useCaptionGeneration());

    await act(() => result.current.start(linked));
    expect(result.current.state).toEqual({
      status: "failed",
      message: "The narration could not be loaded (404).",
    });
    expect(whisper.generateCaptions).not.toHaveBeenCalled();
  });

  it("goes quietly back to idle when cancelled", async () => {
    whisper.generateCaptions.mockImplementation(
      (_recording, _audio, { signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted")));
        }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useCaptionGeneration());

    let job: Promise<void> = Promise.resolve();
    act(() => {
      job = result.current.start(lesson);
    });
    await waitFor(() => expect(whisper.generateCaptions).toHaveBeenCalled());
    await act(async () => {
      result.current.cancel();
      await job;
    });

    expect(result.current.state).toEqual({ status: "idle" });
    expect(errors).not.toHaveBeenCalled();
    expect(actions.addCaptionTrack).not.toHaveBeenCalled();
  });

  it("stops a job still running when the player goes away", async () => {
    let signal: AbortSignal | undefined;
    whisper.generateCaptions.mockImplementation((_recording, _audio, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const { result, unmount } = renderHook(() => useCaptionGeneration());

    act(() => {
      void result.current.start(lesson);
    });
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
