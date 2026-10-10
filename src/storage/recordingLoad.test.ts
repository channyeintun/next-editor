import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import { decompressBinaryToRecording } from "./recordingCodecClient";
import { fetchNextEditorUrl } from "./recordingFetch";
import {
  loadRecordingFromUrl,
  NARRATION_GATE_TIMEOUT_MS,
  type RecordingLoadSink,
} from "./recordingLoad";
import { encodeRecordingToStream } from "./streamingRecordingCodec";

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

/** A narration download's response. */
function audioResponse(): Response {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }),
  } as unknown as Response;
}

/** A gate the test opens by hand. */
function narrationGate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate: vi.fn<() => Promise<void>>(() => opened), open };
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
  describe("the narration download", () => {
    const narrated = { audioFile: "lesson.ogg", audioSource: "external" } as const;

    it("waits for the narration gate, then downloads", async () => {
      const bytes = await encodeRecordingToStream(createRecording(2, narrated));
      vi.mocked(fetchNextEditorUrl).mockImplementation(async (url) =>
        url.endsWith(".ne") ? streamedResponse(bytes) : audioResponse(),
      );
      const { gate, open } = narrationGate();
      const sink = { ...createSink(), narrationGate: gate };

      await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);
      await settle();

      expect(gate).toHaveBeenCalledTimes(1);
      expect(fetchedUrls()).toEqual([LESSON_URL]);
      expect(sink.extend.mock.calls.some(([recording]) => recording.audioBlob)).toBe(false);

      open();
      await vi.waitFor(() => {
        expect(sink.extend.mock.calls.at(-1)?.[0].audioBlob).toBeInstanceOf(Blob);
      });
      expect(fetchedUrls()).toEqual([LESSON_URL, "https://example.com/lesson.ogg"]);
    });

    it("downloads without waiting when the sink has no gate", async () => {
      const bytes = await encodeRecordingToStream(createRecording(2, narrated));
      vi.mocked(fetchNextEditorUrl).mockImplementation(async (url) =>
        url.endsWith(".ne") ? streamedResponse(bytes) : audioResponse(),
      );
      const sink = createSink();

      await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);

      await vi.waitFor(() => {
        expect(sink.extend.mock.calls.at(-1)?.[0].audioBlob).toBeInstanceOf(Blob);
      });
    });

    it("downloads anyway once a gate that never opens times out", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const bytes = await encodeRecordingToStream(createRecording(2, narrated));
        vi.mocked(fetchNextEditorUrl).mockImplementation(async (url) =>
          url.endsWith(".ne") ? streamedResponse(bytes) : audioResponse(),
        );
        const { gate } = narrationGate();
        const sink = { ...createSink(), narrationGate: gate };

        await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);
        await vi.advanceTimersByTimeAsync(NARRATION_GATE_TIMEOUT_MS - 1);
        expect(fetchedUrls()).toEqual([LESSON_URL]);

        await vi.advanceTimersByTimeAsync(1);
        await vi.waitFor(() => {
          expect(sink.extend.mock.calls.at(-1)?.[0].audioBlob).toBeInstanceOf(Blob);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops waiting, and downloads nothing, once the lesson is left", async () => {
      const bytes = await encodeRecordingToStream(createRecording(2, narrated));
      vi.mocked(fetchNextEditorUrl).mockImplementation(async (url) =>
        url.endsWith(".ne") ? streamedResponse(bytes) : audioResponse(),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { gate } = narrationGate();
      const sink = { ...createSink(), narrationGate: gate };
      const controller = new AbortController();

      await loadRecordingFromUrl(LESSON_URL, controller.signal, sink);
      await settle();
      expect(gate).toHaveBeenCalledTimes(1);
      controller.abort();
      await settle();

      expect(fetchedUrls()).toEqual([LESSON_URL]);
      expect(sink.extend.mock.calls.some(([recording]) => recording.audioBlob)).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it("never asks the gate when there is no narration to download", async () => {
      const bytes = await encodeRecordingToStream(createRecording(2));
      vi.mocked(fetchNextEditorUrl).mockResolvedValue(streamedResponse(bytes));
      const { gate } = narrationGate();
      const sink = { ...createSink(), narrationGate: gate };

      await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);
      await settle();

      expect(gate).not.toHaveBeenCalled();
      expect(fetchedUrls()).toEqual([LESSON_URL]);
    });

    it("hands a camera fix over without waiting for the gate", async () => {
      const bytes = await encodeRecordingToStream(
        createRecording(2, { ...narrated, cameraFile: "renamed.webm" }),
      );
      vi.mocked(fetchNextEditorUrl).mockImplementation(async (url) =>
        url.endsWith(".ne") ? streamedResponse(bytes) : audioResponse(),
      );
      // The camera probe asks through the same-origin proxy: the stored name is gone, the
      // `.ne` basename is where the video lives now.
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
          const target = new URL(String(input)).searchParams.get("url") ?? String(input);
          return target.endsWith("/lesson.webm")
            ? new Response(null, { status: 200, headers: { "content-type": "video/webm" } })
            : new Response(null, { status: 404 });
        }),
      );
      const { gate, open } = narrationGate();
      const sink = { ...createSink(), narrationGate: gate };

      try {
        await loadRecordingFromUrl(LESSON_URL, new AbortController().signal, sink);
        await vi.waitFor(() => {
          expect(sink.extend.mock.calls.at(-1)?.[0].cameraUrl).toBe(
            "https://example.com/lesson.webm",
          );
        });
        expect(sink.extend.mock.calls.at(-1)?.[0].audioBlob).toBeUndefined();

        open();
        await vi.waitFor(() => {
          expect(sink.extend.mock.calls.at(-1)?.[0].audioBlob).toBeInstanceOf(Blob);
        });
        expect(sink.extend.mock.calls.at(-1)?.[0].cameraUrl).toBe(
          "https://example.com/lesson.webm",
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
