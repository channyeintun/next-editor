import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import { decompressBinaryToRecording } from "./recordingCodecClient";
import { fetchNextEditorUrl } from "./recordingFetch";
import { loadRecordingFromUrl, type RecordingLoadSink } from "./recordingLoad";
import { encodeRecordingToStream } from "./streamingRecordingCodec";
import { yieldToMain } from "../utils/idle";

vi.mock("./recordingFetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./recordingFetch")>();
  return { ...actual, fetchNextEditorUrl: vi.fn<typeof actual.fetchNextEditorUrl>() };
});

// A pass-through spy, so a test can hold the whole-file decode while a newer load starts.
vi.mock("./recordingCodecClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./recordingCodecClient")>();
  return {
    ...actual,
    decompressBinaryToRecording: vi.fn<typeof actual.decompressBinaryToRecording>(
      actual.decompressBinaryToRecording,
    ),
  };
});

// A pass-through spy, so a test can see where the streamed decode yields.
vi.mock("../utils/idle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/idle")>();
  return { ...actual, yieldToMain: vi.fn<typeof actual.yieldToMain>(actual.yieldToMain) };
});

const LESSON_URL = "https://example.com/lesson.ne";

/** Incompressible text, so an encoded recording is as large as its content. */
function noiseText(seed: number, length: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let state = seed;
  let text = "";
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    text += alphabet[(state >>> 0) % 64];
  }
  return text;
}

/** A recording of `frameCount` keyframes of 4000 random characters each. */
function createRecording(frameCount: number, overrides: Partial<Recording> = {}): Recording {
  return {
    version: 4,
    id: "lesson",
    name: "Lesson",
    createdAt: 1_700_000_000_000,
    duration: frameCount * 100,
    keyframeInterval: 120,
    frames: Array.from({ length: frameCount }, (_, index) => ({
      isKeyframe: true,
      timestamp: index * 100,
      state: {
        content: noiseText(index + 1, 4000),
        position: { lineNumber: 1, column: 1 },
        selection: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 1,
          selectionStartLineNumber: 1,
          selectionStartColumn: 1,
          positionLineNumber: 1,
          positionColumn: 1,
        },
        viewState: null,
      },
    })),
    ...overrides,
  };
}

/** A response whose body arrives 16 KB per read and breaks with a network TypeError at `failAfter`. */
function streamedResponse(bytes: Uint8Array, failAfter = Infinity): Response {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= failAfter) {
          controller.error(new TypeError("network error"));
          return;
        }
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + 16 * 1024));
        offset += 16 * 1024;
      },
    },
    { highWaterMark: 0 },
  );
  return { ok: true, status: 200, body } as unknown as Response;
}

/** A response whose whole body arrives in one read, as from the HTTP cache. */
function oneChunkResponse(bytes: Uint8Array): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

/** A response without a readable body, which the loader reads whole. */
function wholeResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    body: null,
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as Response;
}

function createSink(isStale: () => boolean = () => false) {
  return {
    isStale,
    load: vi.fn<RecordingLoadSink["load"]>(),
    appendDelta: vi.fn<RecordingLoadSink["appendDelta"]>(),
    extend: vi.fn<RecordingLoadSink["extend"]>(),
    addCaptionTrack: vi.fn<RecordingLoadSink["addCaptionTrack"]>(),
  } satisfies RecordingLoadSink;
}

/**
 * Stands in for the network the media probes use (they ask through the same-origin proxy):
 * only the files in `existing` are there. Returns the requests it saw.
 */
function stubMediaHost(existing: Record<string, string>) {
  const requests: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input)).searchParams.get("url") ?? String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      const contentType = existing[url];
      return contentType
        ? new Response(null, { status: 200, headers: { "content-type": contentType } })
        : new Response(null, { status: 404 });
    }),
  );
  return requests;
}

/** The URLs fetchNextEditorUrl was asked for, in order. */
function fetchedUrls(): string[] {
  return vi.mocked(fetchNextEditorUrl).mock.calls.map(([url]) => url);
}

/** Lets pending promise callbacks (and the stream reader) run. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("loadRecordingFromUrl", () => {
  beforeEach(() => {
    vi.mocked(fetchNextEditorUrl).mockReset();
    vi.mocked(decompressBinaryToRecording).mockClear();
    vi.mocked(yieldToMain).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the whole file again when the download breaks after it started", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bytes = await encodeRecordingToStream(createRecording(40));
    vi.mocked(fetchNextEditorUrl)
      .mockResolvedValueOnce(streamedResponse(bytes, 32 * 1024))
      .mockResolvedValueOnce(wholeResponse(bytes));
    const sink = createSink();

    await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);

    expect(fetchNextEditorUrl).toHaveBeenCalledTimes(2);
    const [reloaded] = sink.load.mock.calls.at(-1) ?? [];
    expect(reloaded?.frames).toHaveLength(40);
  });

  it("does not fetch again when the bytes fail to decode", async () => {
    const notARecording = new Uint8Array(256 * 1024).fill(0xff);
    vi.mocked(fetchNextEditorUrl).mockResolvedValue(streamedResponse(notARecording));
    const sink = createSink();

    await expect(
      loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink),
    ).rejects.toThrow("bad magic number");

    expect(fetchNextEditorUrl).toHaveBeenCalledTimes(1);
    expect(sink.load).not.toHaveBeenCalled();
  });

  it("hands nothing to the sink once a newer load has started", async () => {
    const bytes = await encodeRecordingToStream(
      createRecording(2, { captionFiles: ["lesson.en.vtt"] }),
    );
    vi.mocked(fetchNextEditorUrl).mockResolvedValue(streamedResponse(bytes));
    const sink = createSink(() => true);

    await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);

    // Not the lesson's body, nor its sibling captions.
    expect(fetchNextEditorUrl).toHaveBeenCalledTimes(1);
    expect(sink.load).not.toHaveBeenCalled();
    expect(sink.appendDelta).not.toHaveBeenCalled();
    expect(sink.extend).not.toHaveBeenCalled();
    expect(sink.addCaptionTrack).not.toHaveBeenCalled();
  });

  it("drops a whole-file decode that a newer load overtook", async () => {
    const stale = { current: false };
    vi.mocked(decompressBinaryToRecording).mockImplementationOnce(async () => {
      // A dropped file starts a newer load while this one decodes.
      stale.current = true;
      return createRecording(1);
    });
    vi.mocked(fetchNextEditorUrl).mockResolvedValue(wholeResponse(new Uint8Array([1, 2, 3])));
    const sink = createSink(() => stale.current);

    await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);

    expect(decompressBinaryToRecording).toHaveBeenCalledTimes(1);
    expect(sink.load).not.toHaveBeenCalled();
  });
  // The player streams the narration from `audioUrl` once the lesson plays. The loader only
  // works out which URL that is: it never downloads the file.
  describe("the narration", () => {
    const narrated = { audioFile: "lesson.ogg", audioSource: "external" } as const;

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("downloads none of it, and asks nothing when there is one place it can be", async () => {
      const bytes = await encodeRecordingToStream(createRecording(2, narrated));
      vi.mocked(fetchNextEditorUrl).mockResolvedValue(streamedResponse(bytes));
      const requests = stubMediaHost({});
      const mediaSettled = vi.fn<NonNullable<RecordingLoadSink["mediaSettled"]>>();
      const sink = { ...createSink(), mediaSettled };

      await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);

      await vi.waitFor(() => expect(mediaSettled).toHaveBeenCalledTimes(1));
      const outcome = mediaSettled.mock.calls[0][0];
      expect("recording" in outcome && outcome.recording.audioUrl).toBe(
        "https://example.com/lesson.ogg",
      );
      expect("recording" in outcome && outcome.recording.audioBlob).toBeUndefined();
      expect(fetchedUrls()).toEqual([LESSON_URL]);
      expect(requests).toEqual([]);
      expect(sink.load.mock.calls[0]?.[0].audioUrl).toBe("https://example.com/lesson.ogg");
    });

    it("finds a renamed narration with a probe, not a download", async () => {
      const bytes = await encodeRecordingToStream(
        createRecording(2, { audioFile: "old-name.ogg", audioSource: "external" }),
      );
      vi.mocked(fetchNextEditorUrl).mockResolvedValue(streamedResponse(bytes));
      // The stored name is gone; the `.ne` basename is where the narration lives now.
      const requests = stubMediaHost({ "https://example.com/lesson.ogg": "audio/ogg" });
      const sink = createSink();

      await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);

      await vi.waitFor(() => {
        expect(sink.extend.mock.calls.at(-1)?.[0].audioUrl).toBe("https://example.com/lesson.ogg");
      });
      expect(sink.extend.mock.calls.at(-1)?.[0].audioBlob).toBeUndefined();
      expect(fetchedUrls()).toEqual([LESSON_URL]);
      // Probes only (a HEAD, then a one-byte ranged GET where HEAD is refused): each
      // candidate in turn, through the proxy and then directly where the proxy says 404.
      expect([...new Set(requests.map(({ url }) => url))]).toEqual([
        "https://example.com/old-name.ogg",
        "https://example.com/lesson.ogg",
      ]);
      expect(requests.at(-1)).toEqual({ url: "https://example.com/lesson.ogg", method: "HEAD" });
    });

    it("reports a lesson without narration as settled too", async () => {
      const bytes = await encodeRecordingToStream(createRecording(2));
      vi.mocked(fetchNextEditorUrl).mockResolvedValue(streamedResponse(bytes));
      const requests = stubMediaHost({});
      const mediaSettled = vi.fn<NonNullable<RecordingLoadSink["mediaSettled"]>>();
      const sink = { ...createSink(), mediaSettled };

      await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);

      await vi.waitFor(() => expect(mediaSettled).toHaveBeenCalledTimes(1));
      const outcome = mediaSettled.mock.calls[0][0];
      expect("recording" in outcome && outcome.recording.audioUrl).toBeUndefined();
      expect(requests).toEqual([]);
      expect(sink.extend.mock.calls.some(([recording]) => recording.audioUrl)).toBe(false);
    });

    it("reports nothing once the lesson is left", async () => {
      const bytes = await encodeRecordingToStream(
        createRecording(2, { audioFile: "old-name.ogg", audioSource: "external" }),
      );
      vi.mocked(fetchNextEditorUrl).mockResolvedValue(streamedResponse(bytes));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // A probe that only ends when the load is aborted.
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        ),
      );
      const mediaSettled = vi.fn<NonNullable<RecordingLoadSink["mediaSettled"]>>();
      const sink = { ...createSink(), mediaSettled };
      const controller = new AbortController();

      await loadRecordingFromUrl(LESSON_URL, controller.signal, sink);
      await settle();
      controller.abort();
      await settle();

      expect(mediaSettled).not.toHaveBeenCalled();
      expect(sink.extend.mock.calls.some(([recording]) => recording.audioBlob)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it("hands a camera fix and a narration fix over together", async () => {
      const bytes = await encodeRecordingToStream(
        createRecording(2, {
          audioFile: "old-name.ogg",
          audioSource: "external",
          cameraFile: "renamed.webm",
        }),
      );
      vi.mocked(fetchNextEditorUrl).mockResolvedValue(streamedResponse(bytes));
      // Both stored names are gone; the `.ne` basename is where each file lives now.
      stubMediaHost({
        "https://example.com/lesson.webm": "video/webm",
        "https://example.com/lesson.ogg": "audio/ogg",
      });
      const sink = createSink();

      await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);

      await vi.waitFor(() => {
        expect(sink.extend.mock.calls.at(-1)?.[0].audioUrl).toBe("https://example.com/lesson.ogg");
      });
      expect(sink.extend.mock.calls.at(-1)?.[0].cameraUrl).toBe("https://example.com/lesson.webm");
    });
  });
  describe("a body that arrives in one chunk", () => {
    /** Makes every decode slice take longer than the budget, so the decode yields after each. */
    function slowClock() {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => (now += 100));
    }

    it("is decoded a slice at a time, the first playable prefix loading first", async () => {
      slowClock();
      const recording = createRecording(80);
      const bytes = await encodeRecordingToStream(recording);
      expect(bytes.length).toBeGreaterThan(3 * 64 * 1024);
      vi.mocked(fetchNextEditorUrl).mockResolvedValue(oneChunkResponse(bytes));
      const sink = createSink();
      const loadsAtEachYield: number[] = [];
      vi.mocked(yieldToMain).mockImplementation(async () => {
        loadsAtEachYield.push(sink.load.mock.calls.length);
      });

      await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);

      // One task per slice; the prefix loaded in the first, before the rest decoded.
      expect(loadsAtEachYield.length).toBeGreaterThanOrEqual(3);
      expect(loadsAtEachYield[0]).toBe(1);
      expect(sink.load).toHaveBeenCalledTimes(1);
      const [prefix] = sink.load.mock.calls[0] ?? [];
      expect(prefix?.frames.length).toBeGreaterThan(0);
      expect(prefix?.frames.length).toBeLessThan(80);
      // The same recording as decoding the body whole.
      const [final] = sink.extend.mock.calls.at(-1) ?? [];
      expect(final?.streamFinalized).toBe(true);
      const contents = (frames: Recording["frames"] = []) =>
        frames.map((frame) => (frame.isKeyframe ? frame.state.content : null));
      expect(contents(final?.frames)).toEqual(contents(recording.frames));
      const appended = sink.appendDelta.mock.calls.reduce(
        (count, [delta]) => count + delta.newFrames.length,
        0,
      );
      expect((prefix?.frames.length ?? 0) + appended).toBe(80);
    });

    it("stops decoding once a newer load has started", async () => {
      slowClock();
      const bytes = await encodeRecordingToStream(createRecording(40));
      vi.mocked(fetchNextEditorUrl).mockResolvedValue(oneChunkResponse(bytes));
      const stale = { current: false };
      const sink = createSink(() => stale.current);
      sink.load.mockImplementation(() => {
        // A dropped file starts a newer load right after the prefix lands.
        stale.current = true;
      });

      await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);

      expect(sink.load).toHaveBeenCalledTimes(1);
      expect(yieldToMain).toHaveBeenCalledTimes(1);
      expect(sink.appendDelta).not.toHaveBeenCalled();
      expect(sink.extend).not.toHaveBeenCalled();
    });
  });
});
