import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../../core/src";
import type { RecordingLoadSink } from "../../storage/recordingLoad";
import { loadRecordingFromUrl } from "../../storage/recordingLoad";
import { loadRecordingNarration } from "../../storage/recordingSiblingMedia";
import { decodeVoiceAudio } from "./customVoices";
import { loadLessonNarration } from "./lessonVoiceClip";

// loadLessonNarration joins three owners: the .ne loader (stubbed so a test decides when and
// how mediaSettled fires), the narration resolver (the real one, so inline vs sibling audio is
// the shipped rule), and the decoder (stubbed: there is no AudioContext here).
vi.mock("../../storage/recordingLoad", () => ({
  loadRecordingFromUrl: vi.fn<typeof import("../../storage/recordingLoad").loadRecordingFromUrl>(),
}));
vi.mock("../../storage/recordingSiblingMedia", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../storage/recordingSiblingMedia")>();
  return {
    loadRecordingNarration: vi.fn<typeof actual.loadRecordingNarration>(
      actual.loadRecordingNarration,
    ),
  };
});
vi.mock("./customVoices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./customVoices")>()),
  decodeVoiceAudio: vi.fn<typeof import("./customVoices").decodeVoiceAudio>(),
}));

const NE_URL = "https://next-editor.example/media/lessons/a/a.ne";

function decoded(length: number): AudioBuffer {
  return { length } as AudioBuffer;
}

/** The loader settles its media with `outcome` once the .ne is read. */
function loaderSettles(outcome: { recording: Partial<Recording> } | { error: unknown }) {
  vi.mocked(loadRecordingFromUrl).mockImplementation(async (_url, _signal, sink) => {
    sink.mediaSettled?.(outcome as Parameters<NonNullable<RecordingLoadSink["mediaSettled"]>>[0]);
  });
}

/** The loader keeps the .ne loading until the returned function settles its media. */
function loaderPending(): (recording: Partial<Recording>) => void {
  let sink: RecordingLoadSink | undefined;
  vi.mocked(loadRecordingFromUrl).mockImplementation(async (_url, _signal, given) => {
    sink = given;
  });
  return (recording) => sink?.mediaSettled?.({ recording: recording as Recording });
}

function bytesOf(call: number): string {
  const bytes = vi.mocked(decodeVoiceAudio).mock.calls[call]?.[0];
  return bytes ? new TextDecoder().decode(bytes) : "";
}

beforeEach(() => {
  vi.mocked(decodeVoiceAudio).mockResolvedValue(decoded(24_000));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("loadLessonNarration", () => {
  it("decodes the narration stored inline in the .ne", async () => {
    loaderSettles({ recording: { audioBlob: new Blob(["inline"]) } });

    const narration = await loadLessonNarration(NE_URL, new AbortController().signal);

    expect(narration).toEqual(decoded(24_000));
    expect(vi.mocked(loadRecordingFromUrl).mock.calls[0]?.[0]).toBe(NE_URL);
    expect(bytesOf(0)).toBe("inline");
    expect(vi.mocked(decodeVoiceAudio).mock.calls[0]?.[1]).toBe(24_000);
  });

  it("fetches the sibling audio file when the .ne only names it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("sibling"));
    vi.stubGlobal("fetch", fetchMock);
    loaderSettles({ recording: { audioUrl: "blob:next-editor/audio" } });

    const narration = await loadLessonNarration(NE_URL, new AbortController().signal);

    expect(narration).toEqual(decoded(24_000));
    expect(fetchMock).toHaveBeenCalledWith("blob:next-editor/audio");
    expect(bytesOf(0)).toBe("sibling");
  });

  it("is null when the lesson has no narration", async () => {
    loaderSettles({ recording: {} });

    expect(await loadLessonNarration(NE_URL, new AbortController().signal)).toBeNull();
    expect(decodeVoiceAudio).not.toHaveBeenCalled();
  });

  it("is null when the narration is empty or decodes to nothing", async () => {
    loaderSettles({ recording: { audioBlob: new Blob([]) } });
    expect(await loadLessonNarration(NE_URL, new AbortController().signal)).toBeNull();
    expect(decodeVoiceAudio).not.toHaveBeenCalled();

    loaderSettles({ recording: { audioBlob: new Blob(["silence"]) } });
    vi.mocked(decodeVoiceAudio).mockResolvedValueOnce(decoded(0));
    expect(await loadLessonNarration(NE_URL, new AbortController().signal)).toBeNull();
  });

  it("rejects with the loader's media error", async () => {
    const error = new Error("The lesson's media could not be read");
    loaderSettles({ error });

    await expect(loadLessonNarration(NE_URL, new AbortController().signal)).rejects.toBe(error);
    expect(loadRecordingNarration).not.toHaveBeenCalled();
  });

  it("rejects when the .ne itself fails to load", async () => {
    const error = new Error("Not found (404)");
    vi.mocked(loadRecordingFromUrl).mockRejectedValue(error);

    await expect(loadLessonNarration(NE_URL, new AbortController().signal)).rejects.toBe(error);
    expect(loadRecordingNarration).not.toHaveBeenCalled();
  });

  it("does not start loading once already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(loadLessonNarration(NE_URL, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(loadRecordingFromUrl).not.toHaveBeenCalled();
    expect(loadRecordingNarration).not.toHaveBeenCalled();
  });

  it("rejects with an AbortError when aborted while the .ne loads, ignoring a late settle", async () => {
    const settle = loaderPending();
    const controller = new AbortController();
    const loading = loadLessonNarration(NE_URL, controller.signal);
    await vi.waitFor(() => expect(loadRecordingFromUrl).toHaveBeenCalled());

    controller.abort();
    settle({ audioBlob: new Blob(["late"]) });

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(loadRecordingNarration).not.toHaveBeenCalled();
    expect(decodeVoiceAudio).not.toHaveBeenCalled();
  });

  it("rejects with an AbortError when aborted while the sibling audio resolves", async () => {
    let finishNarration: (blob: Blob) => void = () => {};
    vi.mocked(loadRecordingNarration).mockImplementationOnce(
      () => new Promise<Blob>((resolve) => (finishNarration = resolve)),
    );
    loaderSettles({ recording: { audioUrl: "blob:next-editor/audio" } });
    const controller = new AbortController();
    const loading = loadLessonNarration(NE_URL, controller.signal);
    await vi.waitFor(() => expect(loadRecordingNarration).toHaveBeenCalled());

    controller.abort();
    finishNarration(new Blob(["sibling"]));

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(decodeVoiceAudio).not.toHaveBeenCalled();
  });
});
