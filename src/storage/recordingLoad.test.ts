import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../core/src";
import { decompressBinaryToRecording } from "./recordingCodecClient";
import { fetchNextEditorUrl } from "./recordingFetch";
import { loadRecordingFromUrl, type RecordingLoadSink } from "./recordingLoad";
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
});
