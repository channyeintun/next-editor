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
    handleWhiteboardEvent: vi.fn(),
    handleChatEvent: vi.fn(),
    exportAsFile: vi.fn(),
    importFromFile: vi.fn(),
    clearStorage: vi.fn(),
    getStorageStats: vi.fn(),
    listStoredRecordings: vi.fn(),
    loadStoredRecordingById: vi.fn(),
    deleteFromStorage: vi.fn(),
  };
}
/* eslint-enable vitest/require-mock-type-parameters */

/**
 * `fetchNextEditorUrl` routes cross-origin requests through the same-origin `/api/proxy`
 * endpoint (`?url=<encoded target>`), since the test origin (`http://localhost`) differs from
 * `https://example.com`. Mocks that only care about the real target URL should match against
 * this, not the raw request URL.
 */
function targetUrl(requestUrl: string): string {
  const parsed = new URL(requestUrl, "http://localhost");
  const proxied = parsed.searchParams.get("url");
  return proxied ?? requestUrl;
}

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
    text: async () => (body ? new TextDecoder().decode(body) : ""),
  } as unknown as Response;
}

/** A minimal valid single-cue VTT file body, used by caption-fallback tests. */
function vttBody(): Uint8Array {
  return new TextEncoder().encode("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n");
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
      const url = targetUrl(typeof input === "string" ? input : input.toString());
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

  it("resolves audio via the .ne basename when external audio is declared without a filename", async () => {
    // Older exports wrote `audioSource: "external"` without persisting `audioFile`/`audioUrl`
    // (the blob wasn't in memory at export time). The declaration alone must be enough to try
    // the `.ne`-basename sibling — this is the real-world "drop `introduction.weba` next to
    // `introduction.ne`" case.
    const recording = createRecording({ audioSource: "external" });
    const neBytes = await encodeRecordingToStream(recording);
    const audioBytes = new Uint8Array([1, 2, 3, 4]);

    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
      const url = targetUrl(typeof input === "string" ? input : input.toString());
      if (url.endsWith(".ne")) {
        return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
      }
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

  it("prefers a configured audio URL over the stored sibling filename and .ne-basename fallback", async () => {
    // All three candidates are reachable — the configured URL (candidate 1) must win.
    const recording = createRecording({
      audioFile: "lesson.weba",
      audioUrl: "https://cdn.example.com/hosted-audio.weba",
      audioSource: "external",
    });
    const neBytes = await encodeRecordingToStream(recording);
    const audioBytes = new Uint8Array([9, 9, 9]);

    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
      const url = targetUrl(typeof input === "string" ? input : input.toString());
      if (url.endsWith(".ne")) {
        return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
      }
      // Every candidate resolves — the test asserts which one is actually picked.
      return fakeResponse(audioBytes, { ok: true, contentType: "audio/webm" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const actions = makeActionsMock();
    const extendRecordingMock = vi.mocked(actions.extendRecording);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(NextEditorActionsContext.Provider, { value: actions }, children);

    const { result } = renderHook(() => useUrlLoader(), { wrapper });

    await result.current.fetchNextEditorFile("https://example.com/intro-01.ne");

    await waitFor(() => {
      expect(extendRecordingMock).toHaveBeenCalled();
    });

    const [extended] = extendRecordingMock.mock.calls.at(-1) as [Recording];
    expect(extended.audioUrl).toBe("https://cdn.example.com/hosted-audio.weba");
  });

  it("falls back to the stored sibling filename when no configured URL is set", async () => {
    const recording = createRecording({ audioFile: "lesson.weba", audioSource: "external" });
    const neBytes = await encodeRecordingToStream(recording);
    const audioBytes = new Uint8Array([1, 2, 3]);

    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
      const url = targetUrl(typeof input === "string" ? input : input.toString());
      if (url.endsWith(".ne")) {
        return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
      }
      // The stored sibling filename resolves fine — the .ne-basename fallback must not be used.
      if (url.endsWith("/lesson.weba")) {
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

    await waitFor(() => {
      expect(extendRecordingMock).toHaveBeenCalled();
    });

    const [extended] = extendRecordingMock.mock.calls.at(-1) as [Recording];
    expect(extended.audioUrl).toBe("https://example.com/lesson.weba");
  });

  it("resolves a relative configured audio URL against the .ne URL instead of throwing", async () => {
    // `audioUrl` can be a URL relative to the `.ne` file. Before the fix, `new URL(storedUrl)`
    // on this raw relative string threw inside the candidate loop, silently skipping straight
    // to the next candidate; this test pins that the relative URL itself is resolved and used.
    const recording = createRecording({
      audioFile: "lesson.weba",
      audioUrl: "media/hosted-audio.weba",
      audioSource: "external",
    });
    const neBytes = await encodeRecordingToStream(recording);
    const audioBytes = new Uint8Array([4, 5, 6]);

    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
      const url = targetUrl(typeof input === "string" ? input : input.toString());
      if (url.endsWith(".ne")) {
        return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
      }
      if (url.endsWith("/media/hosted-audio.weba")) {
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

    await waitFor(() => {
      expect(extendRecordingMock).toHaveBeenCalled();
    });

    const [extended] = extendRecordingMock.mock.calls.at(-1) as [Recording];
    expect(extended.audioUrl).toBe("https://example.com/media/hosted-audio.weba");
    expect(extended.audioBlob).toBeInstanceOf(Blob);
  });

  it("deduplicates candidates when the configured URL equals the stored-filename resolution", async () => {
    // Configured URL and the stored-sibling resolution are the exact same absolute URL —
    // the candidate list must not probe/fetch it twice.
    const recording = createRecording({
      audioFile: "lesson.weba",
      audioUrl: "https://example.com/intro-01/lesson.weba",
      audioSource: "external",
    });
    const neBytes = await encodeRecordingToStream(recording);
    const audioBytes = new Uint8Array([7, 8]);

    let audioFetchCount = 0;
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
      const url = targetUrl(typeof input === "string" ? input : input.toString());
      if (url.endsWith(".ne")) {
        return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
      }
      audioFetchCount += 1;
      return fakeResponse(audioBytes, { ok: true, contentType: "audio/webm" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const actions = makeActionsMock();
    const extendRecordingMock = vi.mocked(actions.extendRecording);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(NextEditorActionsContext.Provider, { value: actions }, children);

    const { result } = renderHook(() => useUrlLoader(), { wrapper });

    await result.current.fetchNextEditorFile("https://example.com/intro-01/intro-01.ne");

    await waitFor(() => {
      expect(extendRecordingMock).toHaveBeenCalled();
    });

    // Only one fetch for the (deduplicated) audio candidate.
    expect(audioFetchCount).toBe(1);
  });

  it("probes a camera URL with HEAD first, falling back to a ranged GET when HEAD is rejected", async () => {
    // The stored sibling filename (`old-name.webm`) 404s outright, so the winning candidate is
    // the .ne-basename fallback (`intro-01.webm`) — reachable only via HEAD-reject + ranged-GET
    // fallback (simulating a host, e.g. an S3 presigned URL, that only allows GetObject). Using
    // the basename candidate (rather than the happy-path `cameraFile` guess) also means the
    // resolved URL differs from the initial guess, so `extendRecording` actually fires.
    const recording = createRecording({ cameraFile: "old-name.webm", cameraSource: "camera" });
    const neBytes = await encodeRecordingToStream(recording);

    const requestLog: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input, init) => {
        const url = targetUrl(typeof input === "string" ? input : input.toString());
        const method = init?.method ?? "GET";
        requestLog.push({ url, method });
        if (url.endsWith(".ne")) {
          return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
        }
        if (url.endsWith("/intro-01.webm")) {
          // HEAD rejected (simulates a host that only allows GetObject/ranged GET) via a status
          // the proxy fallback doesn't special-case, so the ranged-GET retry happens on the same
          // (proxied) URL rather than falling through to a raw direct fetch.
          if (init?.method === "HEAD") {
            return fakeResponse(null, { ok: false, status: 403 });
          }
          return fakeResponse(new Uint8Array([1]), { ok: true, contentType: "video/webm" });
        }
        return fakeResponse(null, { ok: false, status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const actions = makeActionsMock();
    const extendRecordingMock = vi.mocked(actions.extendRecording);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(NextEditorActionsContext.Provider, { value: actions }, children);

    const { result } = renderHook(() => useUrlLoader(), { wrapper });

    await result.current.fetchNextEditorFile("https://example.com/intro-01.ne");

    await waitFor(() => {
      expect(extendRecordingMock).toHaveBeenCalled();
    });

    const [extended] = extendRecordingMock.mock.calls.at(-1) as [Recording];
    expect(extended.cameraUrl).toBe("https://example.com/intro-01.webm");

    const cameraRequests = requestLog.filter((entry) => entry.url.endsWith("/intro-01.webm"));
    expect(cameraRequests[0]?.method).toBe("HEAD");
    expect(cameraRequests.some((entry) => entry.method !== "HEAD")).toBe(true);
  });

  it("rejects an HTML response when probing a camera URL and falls through to the next candidate", async () => {
    // The stored sibling filename resolves to a host that answers 200 with an HTML SPA
    // fallback page (not real video) — the probe must reject it and fall through to the
    // .ne-basename candidate, which serves the real file.
    const recording = createRecording({ cameraFile: "lesson.webm", cameraSource: "camera" });
    const neBytes = await encodeRecordingToStream(recording);

    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input) => {
        const url = targetUrl(typeof input === "string" ? input : input.toString());
        if (url.endsWith(".ne")) {
          return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
        }
        if (url.endsWith("/lesson.webm")) {
          return fakeResponse(new Uint8Array([1]), { ok: true, contentType: "text/html" });
        }
        if (url.endsWith("/intro-01.webm")) {
          return fakeResponse(new Uint8Array([2]), { ok: true, contentType: "video/webm" });
        }
        return fakeResponse(null, { ok: false, status: 404 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const actions = makeActionsMock();
    const extendRecordingMock = vi.mocked(actions.extendRecording);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(NextEditorActionsContext.Provider, { value: actions }, children);

    const { result } = renderHook(() => useUrlLoader(), { wrapper });

    await result.current.fetchNextEditorFile("https://example.com/intro-01.ne");

    await waitFor(() => {
      expect(extendRecordingMock).toHaveBeenCalled();
    });

    const [extended] = extendRecordingMock.mock.calls.at(-1) as [Recording];
    expect(extended.cameraUrl).toBe("https://example.com/intro-01.webm");
  });

  it("falls back to the .ne basename VTT when the declared caption file 404s", async () => {
    const recording = createRecording({ captionFiles: ["lesson.vtt"] });
    const neBytes = await encodeRecordingToStream(recording);

    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
      const url = targetUrl(typeof input === "string" ? input : input.toString());
      if (url.endsWith(".ne")) {
        return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
      }
      // The declared caption file (renamed sibling) 404s...
      if (url.endsWith("/lesson.vtt")) {
        return fakeResponse(null, { ok: false, status: 404 });
      }
      // ...the .ne-basename candidate is where the renamed VTT actually lives.
      if (url.endsWith("/intro-01.vtt")) {
        return fakeResponse(vttBody(), { ok: true, contentType: "text/vtt" });
      }
      return fakeResponse(null, { ok: false, status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const actions = makeActionsMock();
    const addCaptionTrackMock = vi.mocked(actions.addCaptionTrack);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(NextEditorActionsContext.Provider, { value: actions }, children);

    const { result } = renderHook(() => useUrlLoader(), { wrapper });

    await result.current.fetchNextEditorFile("https://example.com/intro-01.ne");

    await waitFor(() => {
      expect(addCaptionTrackMock).toHaveBeenCalled();
    });

    expect(addCaptionTrackMock).toHaveBeenCalledTimes(1);
  });

  it("never invents a basename caption candidate when a declared caption file resolves fine", async () => {
    const recording = createRecording({ captionFiles: ["lesson.vtt"] });
    const neBytes = await encodeRecordingToStream(recording);

    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
      const url = targetUrl(typeof input === "string" ? input : input.toString());
      if (url.endsWith(".ne")) {
        return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
      }
      if (url.endsWith("/lesson.vtt")) {
        return fakeResponse(vttBody(), { ok: true, contentType: "text/vtt" });
      }
      // The .ne-basename candidate must never be probed once a declared caption succeeds.
      if (url.endsWith("/intro-01.vtt")) {
        throw new Error("basename caption candidate should not be fetched");
      }
      return fakeResponse(null, { ok: false, status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const actions = makeActionsMock();
    const addCaptionTrackMock = vi.mocked(actions.addCaptionTrack);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(NextEditorActionsContext.Provider, { value: actions }, children);

    const { result } = renderHook(() => useUrlLoader(), { wrapper });

    await result.current.fetchNextEditorFile("https://example.com/intro-01.ne");

    await waitFor(() => {
      expect(addCaptionTrackMock).toHaveBeenCalled();
    });

    expect(addCaptionTrackMock).toHaveBeenCalledTimes(1);
  });

  it("never guesses a basename caption candidate when the recording declares no captionFiles at all", async () => {
    // Unlike audio/camera (always resolvable to *some* default extension), a recording that
    // never mentions captions must not trigger a speculative `.vtt` probe — only a declared
    // caption file that fails is allowed to fall back to the `.ne` basename.
    const recording = createRecording();
    const neBytes = await encodeRecordingToStream(recording);

    const fetchMock = vi.fn<() => Promise<Response>>(async () =>
      fakeResponse(neBytes, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const actions = makeActionsMock();
    const addCaptionTrackMock = vi.mocked(actions.addCaptionTrack);
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(NextEditorActionsContext.Provider, { value: actions }, children);

    const { result } = renderHook(() => useUrlLoader(), { wrapper });

    await result.current.fetchNextEditorFile("https://example.com/plain.ne");

    expect(actions.loadRecording).toHaveBeenCalledTimes(1);
    // Only the `.ne` itself was fetched — no speculative caption probe.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(addCaptionTrackMock).not.toHaveBeenCalled();
  });
});
