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
const recovery = vi.hoisted(() => ({
  importWithChunkRecovery: vi.fn<(importer: () => Promise<unknown>, chunkName: string) => unknown>(
    (importer) => importer(),
  ),
}));
const captionStore = vi.hoisted(() => ({
  selectTrack: vi.fn<(event: { trackId: string; language: string }) => void>(),
  setEnabled: vi.fn<(event: { enabled: boolean }) => void>(),
}));

vi.mock("../captions/generateCaptions", () => whisper);
vi.mock("../routeRecovery", () => recovery);
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
    const { result } = renderHook(() => useCaptionGeneration("lesson"));

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
    expect(recovery.importWithChunkRecovery).toHaveBeenCalledWith(
      expect.any(Function),
      "generateCaptions",
    );

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
    // Named as the captions menu names the track, for the player's status region.
    expect(result.current.notice).toEqual({
      text: "Captions generated: German (auto)",
      at: expect.any(Number),
    });
  });

  it("clears what it last announced when a job starts, is cancelled or its lesson goes", async () => {
    whisper.generateCaptions.mockResolvedValue({ language: "en", cues: hello });
    const { result, rerender } = renderHook(
      ({ recordingId }: { recordingId: string | null }) => useCaptionGeneration(recordingId),
      { initialProps: { recordingId: "lesson" } },
    );
    expect(result.current.notice).toBeNull();

    await act(() => result.current.start(lesson));
    expect(result.current.notice?.text).toBe("Captions generated: English (auto)");
    whisper.generateCaptions.mockImplementation(() => new Promise(() => {}));
    act(() => {
      void result.current.start(lesson);
    });
    expect(result.current.notice).toBeNull();

    whisper.generateCaptions.mockResolvedValue({ language: "en", cues: hello });
    await act(() => result.current.start(lesson));
    act(() => result.current.cancel());
    expect(result.current.notice).toBeNull();

    await act(() => result.current.start(lesson));
    rerender({ recordingId: "another-lesson" });
    expect(result.current.notice).toBeNull();
  });

  it("adds a track beside the lesson's own captions without making it the default", async () => {
    whisper.generateCaptions.mockResolvedValue({ language: "en", cues: hello });
    const captioned = { ...lesson, captions: [{ id: "en", language: "en", cues: [] }] };
    const { result } = renderHook(() => useCaptionGeneration("lesson"));

    await act(() => result.current.start(captioned as Recording));
    expect(actions.addCaptionTrack).toHaveBeenCalledWith(
      "lesson",
      expect.objectContaining({ default: false }),
    );
  });

  it("says so when the narration has no speech", async () => {
    whisper.generateCaptions.mockResolvedValue({ language: "en", cues: [] });
    const { result } = renderHook(() => useCaptionGeneration("lesson"));

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
    const { result } = renderHook(() => useCaptionGeneration("lesson"));

    await act(() => result.current.start(lesson));
    expect(result.current.state).toEqual({
      status: "failed",
      message: "The model could not be loaded.",
    });
  });

  it("says why when the captioning code cannot load after its one reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    recovery.importWithChunkRecovery.mockRejectedValueOnce(
      new TypeError("Failed to fetch dynamically imported module"),
    );
    const { result } = renderHook(() => useCaptionGeneration("lesson"));

    await act(() => result.current.start(lesson));
    expect(result.current.state).toEqual({
      status: "failed",
      message: "Failed to fetch dynamically imported module",
    });
    expect(whisper.generateCaptions).not.toHaveBeenCalled();
  });

  it("says so when a linked narration cannot be fetched", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const linked = { id: "lesson", audioUrl: "https://example.com/lesson.ogg" } as Recording;
    const { result } = renderHook(() => useCaptionGeneration("lesson"));

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
    const { result } = renderHook(() => useCaptionGeneration("lesson"));

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

  it("keeps a restarted job running after the cancelled one settles", async () => {
    whisper.generateCaptions
      .mockImplementationOnce(
        (_recording, _audio, { signal }) =>
          new Promise((_, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted")));
          }),
      )
      .mockImplementationOnce(() => new Promise(() => {}));
    const { result } = renderHook(() => useCaptionGeneration("lesson"));

    let cancelled: Promise<void> = Promise.resolve();
    act(() => {
      cancelled = result.current.start(lesson);
    });
    await waitFor(() => expect(whisper.generateCaptions).toHaveBeenCalledTimes(1));
    await act(async () => {
      result.current.cancel();
      void result.current.start(lesson);
      await cancelled;
    });
    await waitFor(() => expect(whisper.generateCaptions).toHaveBeenCalledTimes(2));

    expect(result.current.state).toEqual({ status: "running", progress: null });
  });

  it("stops a job when another recording is loaded, leaving the captions as they were", async () => {
    let signal: AbortSignal | undefined;
    let finish: () => void = () => {};
    whisper.generateCaptions.mockImplementation(
      (_recording, _audio, options) =>
        new Promise((resolve, reject) => {
          signal = options.signal;
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted")));
          finish = () => resolve({ language: "en", cues: hello });
        }),
    );
    const { result, rerender } = renderHook(
      ({ recordingId }: { recordingId: string | null }) => useCaptionGeneration(recordingId),
      { initialProps: { recordingId: "lesson" } },
    );

    let job: Promise<void> = Promise.resolve();
    act(() => {
      job = result.current.start(lesson);
    });
    await waitFor(() => expect(signal).toBeDefined());
    rerender({ recordingId: "another-lesson" });
    // A job left running would finish here and switch captions on in the other lesson.
    await act(async () => {
      finish();
      await job;
    });

    expect(captionStore.selectTrack).not.toHaveBeenCalled();
    expect(captionStore.setEnabled).not.toHaveBeenCalled();
    expect(actions.addCaptionTrack).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("keeps a job running while the same recording changes", async () => {
    let signal: AbortSignal | undefined;
    whisper.generateCaptions.mockImplementation((_recording, _audio, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const { result, rerender } = renderHook(
      ({ recordingId }: { recordingId: string | null }) => useCaptionGeneration(recordingId),
      { initialProps: { recordingId: "lesson" } },
    );

    act(() => {
      void result.current.start(lesson);
    });
    await waitFor(() => expect(signal).toBeDefined());
    // A new chapter or caption track is a new recording object with the same id.
    rerender({ recordingId: "lesson" });

    expect(signal?.aborted).toBe(false);
    expect(result.current.state).toEqual({ status: "running", progress: null });
  });

  it("stops a job still running when the player goes away", async () => {
    let signal: AbortSignal | undefined;
    whisper.generateCaptions.mockImplementation((_recording, _audio, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const { result, unmount } = renderHook(() => useCaptionGeneration("lesson"));

    act(() => {
      void result.current.start(lesson);
    });
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
