import { renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recording } from "../core/src";
import { NextEditorActionsContext, type NextEditorActions } from "../contexts/NextEditorContext";
import { encodeRecordingToStream } from "../storage/streamingRecordingCodec";
import { useUrlLoader } from "./useUrlLoader";

function createRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    version: 4,
    id: "recording-1",
    name: "URL-loaded recording",
    createdAt: 1_700_000_000_000,
    duration: 1000,
    keyframeInterval: 120,
    frames: [
      {
        isKeyframe: true,
        timestamp: 0,
        state: {
          content: "hello",
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
      },
    ],
    ...overrides,
  };
}

// Most of `NextEditorActions` is unused by `useUrlLoader` — a plain `vi.fn()` per field (rather
// than a type parameter matching each real signature) keeps this mock proportional to that.
/* eslint-disable vitest/require-mock-type-parameters */
function makeActionsMock(): NextEditorActions {
  return {
    editorRef: { current: null },
    syncEditorRef: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    seekTo: vi.fn(),
    setPlaybackSpeed: vi.fn(),
    setVolume: vi.fn(),
    loadRecording: vi.fn(),
    extendRecording: vi.fn(),
    addCaptionTrack: vi.fn(),
    removeCaptionTrack: vi.fn(),
    clearRecording: vi.fn(),
    handleEditorChange: vi.fn(),
    handleSlideEvent: vi.fn(),
    handlePreviewEvent: vi.fn(),
    handlePreviewInitialDocument: vi.fn(),
    handlePreviewPatchBatch: vi.fn(),
    handleWorkspaceEvent: vi.fn(),
    handleRuntimeEvent: vi.fn(),
    exportAsFile: vi.fn(),
    importFromFile: vi.fn(),
    clearStorage: vi.fn(),
    getStorageStats: vi.fn(),
    loadRecordingsFromStorage: vi.fn(),
    listStoredRecordings: vi.fn(),
    loadStoredRecordingById: vi.fn(),
    deleteFromStorage: vi.fn(),
  };
}
/* eslint-enable vitest/require-mock-type-parameters */

function fakeResponse(
  body: Uint8Array | null,
  init: { ok: boolean; status?: number; contentType?: string },
) {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 404),
    statusText: init.ok ? "OK" : "Not Found",
    // No streamable body — forces the whole-file fallback path, which is simpler to mock.
    body: null,
    headers: {
      get: (name: string) => (name === "content-type" ? (init.contentType ?? null) : null),
    },
    arrayBuffer: async () =>
      body
        ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        : new ArrayBuffer(0),
    blob: async () => new Blob(body ? [body as BlobPart] : [], { type: init.contentType }),
  } as unknown as Response;
}

describe("useUrlLoader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to the .ne basename when the stored sibling audio filename 404s", async () => {
    const recording = createRecording({ audioFile: "lesson.weba", audioSource: "external" });
    const neBytes = await encodeRecordingToStream(recording);
    const audioBytes = new Uint8Array([1, 2, 3, 4]);

    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(".ne")) {
        return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
      }
      // The stored-filename candidate (renamed sibling) 404s...
      if (url.endsWith("/lesson.weba")) {
        return fakeResponse(null, { ok: false, status: 404 });
      }
      // ...the .ne-basename candidate is where the renamed file actually lives.
      if (url.endsWith("/intro-01.weba")) {
        return fakeResponse(audioBytes, { ok: true, contentType: "audio/webm" });
      }
      return fakeResponse(null, { ok: false, status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const actions = makeActionsMock();
    const extendRecordingMock = vi.mocked(actions.extendRecording);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(NextEditorActionsContext.Provider, { value: actions }, children);

    const { result } = renderHook(() => useUrlLoader(), { wrapper });

    await result.current.fetchNextEditorFile("https://example.com/intro-01.ne");

    expect(actions.loadRecording).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(extendRecordingMock).toHaveBeenCalled();
    });

    const [extended] = extendRecordingMock.mock.calls.at(-1) as [Recording];
    expect(extended.audioUrl).toBe("https://example.com/intro-01.weba");
    expect(extended.audioBlob).toBeInstanceOf(Blob);
  });

  it("never invents a basename candidate for media the recording didn't reference", async () => {
    const recording = createRecording();
    const neBytes = await encodeRecordingToStream(recording);

    const fetchMock = vi.fn<() => Promise<Response>>(async () =>
      fakeResponse(neBytes, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const actions = makeActionsMock();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(NextEditorActionsContext.Provider, { value: actions }, children);

    const { result } = renderHook(() => useUrlLoader(), { wrapper });

    await result.current.fetchNextEditorFile("https://example.com/plain.ne");

    expect(actions.loadRecording).toHaveBeenCalledTimes(1);
    // Only the `.ne` itself was fetched — no speculative probe for audio/camera.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(actions.extendRecording).not.toHaveBeenCalled();
  });
});
