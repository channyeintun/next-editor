import { act, renderHook, waitFor } from "@testing-library/react";
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
    appendRecordingDelta: vi.fn(),
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

/**
 * A response whose body arrives in `chunkSize` pieces, one per read, the way a slow download
 * does. `pulledBytes()` reports how much of it the loader has read so far, `cancelled()` whether
 * the loader cancelled the rest, `failAfter` makes the download break after that many bytes,
 * `holdAfter` stalls it there until `resume` settles, and `signal` errors it on abort as fetch
 * does.
 */
function streamingResponse(
  bytes: Uint8Array,
  {
    chunkSize = 16 * 1024,
    failAfter = Infinity,
    holdAfter = Infinity,
    resume,
    signal,
  }: {
    chunkSize?: number;
    failAfter?: number;
    holdAfter?: number;
    resume?: Promise<void>;
    signal?: AbortSignal | null;
  } = {},
) {
  let offset = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        signal?.addEventListener("abort", () => {
          controller.error(new DOMException("The operation was aborted.", "AbortError"));
        });
      },
      async pull(controller) {
        if (offset >= holdAfter) await resume;
        if (offset >= failAfter) {
          controller.error(new TypeError("network error"));
          return;
        }
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
        offset += chunkSize;
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const response = {
    ok: true,
    status: 200,
    statusText: "",
    body,
    headers: { get: () => "application/octet-stream" },
  } as unknown as Response;
  return {
    response,
    pulledBytes: () => Math.min(offset, bytes.length),
    cancelled: () => cancelled,
  };
}

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

/** A recording of `frameCount` keyframes of `contentLength` random characters each. */
function largeRecording(
  frameCount: number,
  contentLength: number,
  overrides: Partial<Recording> = {},
) {
  const base = createRecording(overrides);
  const [first] = base.frames;
  if (!first?.isKeyframe) throw new Error("Expected an initial keyframe");
  const frames = Array.from({ length: frameCount }, (_, index) => ({
    ...first,
    timestamp: index * 100,
    state: { ...first.state, content: noiseText(index + 1, contentLength) },
  }));
  return { ...base, frames, duration: frameCount * 100 };
}

/** A promise the test settles by hand, to hold a request open while something else happens. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function renderLoader(actions: NextEditorActions) {
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(NextEditorActionsContext.Provider, { value: actions }, children);
  return renderHook(() => useUrlLoader(), { wrapper });
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

  // Editor.tsx serves the `?url=` load and drag-and-drop from one loader. A dropped file must
  // supersede a URL lesson that is still downloading, or that lesson lands on top of it.
  describe("a file import during a URL load", () => {
    it("keeps the imported lesson when the URL lesson arrives afterwards", async () => {
      const urlBytes = await encodeRecordingToStream(createRecording({ id: "url-lesson" }));
      const droppedBytes = await encodeRecordingToStream(createRecording({ id: "dropped-lesson" }));
      const download = gate();
      vi.stubGlobal(
        "fetch",
        vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => {
          await download.opened;
          return fakeResponse(urlBytes, { ok: true, contentType: "application/octet-stream" });
        }),
      );
      const actions = makeActionsMock();
      const { result } = renderLoader(actions);

      const urlLoad = result.current.fetchNextEditorFile("https://example.com/a.ne");
      await result.current.importNextEditorFile([
        new File([droppedBytes as BlobPart], "dropped.ne"),
      ]);
      download.open();
      await urlLoad;

      const loadedIds = vi.mocked(actions.loadRecording).mock.calls.map(([loaded]) => loaded.id);
      expect(loadedIds).toEqual(["dropped-lesson"]);
    });

    it("does not add the URL lesson's sibling captions to the imported lesson", async () => {
      const urlBytes = await encodeRecordingToStream(
        createRecording({ id: "url-lesson", captionFiles: ["a.en.vtt"] }),
      );
      const droppedBytes = await encodeRecordingToStream(createRecording({ id: "dropped-lesson" }));
      const captionDownload = gate();
      const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
        const url = targetUrl(typeof input === "string" ? input : input.toString());
        if (url.endsWith("/a.ne")) {
          return fakeResponse(urlBytes, { ok: true, contentType: "application/octet-stream" });
        }
        if (url.endsWith("/a.en.vtt")) {
          await captionDownload.opened;
          return fakeResponse(vttBody(), { ok: true, contentType: "text/vtt" });
        }
        return fakeResponse(null, { ok: false, status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const actions = makeActionsMock();
      const { result } = renderLoader(actions);

      await result.current.fetchNextEditorFile("https://example.com/a.ne");
      await waitFor(() => {
        const requested = fetchMock.mock.calls.map(([input]) => targetUrl(String(input)));
        expect(requested).toContain("https://example.com/a.en.vtt");
      });
      await result.current.importNextEditorFile([
        new File([droppedBytes as BlobPart], "dropped.ne"),
      ]);
      captionDownload.open();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(vi.mocked(actions.loadRecording).mock.calls.at(-1)?.[0].id).toBe("dropped-lesson");
      expect(actions.addCaptionTrack).not.toHaveBeenCalled();
    });

    it("replaces a failed URL load's error, and offers Retry only for a URL", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn<() => Promise<Response>>(async () => fakeResponse(null, { ok: false, status: 404 })),
      );
      const actions = makeActionsMock();
      const { result } = renderLoader(actions);

      await expect(result.current.fetchNextEditorFile("https://example.com/a.ne")).rejects.toThrow(
        "Failed to fetch file",
      );
      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });
      expect(result.current.retry).toBeTypeOf("function");

      await act(() => result.current.importNextEditorFile([new File([], "dropped.ne")]));
      expect(result.current.error).toMatch(/Failed to import file/);
      // A dropped file cannot be fetched again.
      expect(result.current.retry).toBeUndefined();
    });
  });

  it("fetches sibling captions through the proxy, like the lesson and its audio", async () => {
    // A host without CORS headers: the page can only reach it through /api/proxy.
    const recording = createRecording({ captionFiles: ["intro.en.vtt"] });
    const neBytes = await encodeRecordingToStream(recording);
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
      const requested = new URL(String(input), window.location.href);
      if (requested.origin !== window.location.origin) {
        throw new TypeError("Failed to fetch");
      }
      const url = targetUrl(requested.toString());
      if (url.endsWith("/intro.ne")) {
        return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
      }
      if (url.endsWith("/intro.en.vtt")) {
        return fakeResponse(vttBody(), { ok: true, contentType: "text/vtt" });
      }
      return fakeResponse(null, { ok: false, status: 502 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const actions = makeActionsMock();
    const { result } = renderLoader(actions);

    await result.current.fetchNextEditorFile("https://cdn.example.org/intro.ne");

    await waitFor(() => {
      expect(actions.addCaptionTrack).toHaveBeenCalledTimes(1);
    });
  });

  it("loads the first playable prefix without waiting for 512 KB", async () => {
    // ~250 KB of keyframes: the first one is decodable after the first 16 KB chunk.
    const bytes = await encodeRecordingToStream(largeRecording(60, 4000));
    const stream = streamingResponse(bytes);
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => stream.response),
    );
    const actions = makeActionsMock();
    let pulledAtLoad = -1;
    vi.mocked(actions.loadRecording).mockImplementation(() => {
      pulledAtLoad = stream.pulledBytes();
    });
    const { result } = renderLoader(actions);

    await result.current.fetchNextEditorFile("https://example.com/big.ne");

    expect(actions.loadRecording).toHaveBeenCalledTimes(1);
    expect(pulledAtLoad).toBeGreaterThan(0);
    expect(pulledAtLoad).toBeLessThanOrEqual(64 * 1024);
    // Everything decoded after that first load still arrives, and the finalized stream is
    // installed whole.
    const [extended] = vi.mocked(actions.extendRecording).mock.calls.at(-1) ?? [];
    expect(extended?.frames).toHaveLength(60);
  });

  describe("when streaming fails", () => {
    it("reports a body that is not a .ne without downloading it again", async () => {
      const notARecording = new Uint8Array(256 * 1024).fill(0xff);
      const stream = streamingResponse(notARecording);
      const fetchMock = vi.fn<() => Promise<Response>>();
      fetchMock
        .mockResolvedValueOnce(stream.response)
        .mockResolvedValueOnce(
          fakeResponse(notARecording, { ok: true, contentType: "application/octet-stream" }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const actions = makeActionsMock();
      const { result } = renderLoader(actions);

      await expect(result.current.fetchNextEditorFile("https://example.com/a.ne")).rejects.toThrow(
        "bad magic number",
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(stream.cancelled()).toBe(true);
      expect(stream.pulledBytes()).toBeLessThan(notARecording.length);
      await waitFor(() => {
        expect(result.current.error).toMatch(/bad magic number/);
      });
    });

    it("fetches the whole file again when the download breaks", async () => {
      const bytes = await encodeRecordingToStream(largeRecording(40, 4000, { id: "lesson" }));
      const broken = streamingResponse(bytes, { failAfter: 32 * 1024 });
      const fetchMock = vi.fn<() => Promise<Response>>();
      fetchMock
        .mockResolvedValueOnce(broken.response)
        .mockResolvedValueOnce(
          fakeResponse(bytes, { ok: true, contentType: "application/octet-stream" }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const actions = makeActionsMock();
      const { result } = renderLoader(actions);

      await result.current.fetchNextEditorFile("https://example.com/a.ne");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [reloaded] = vi.mocked(actions.loadRecording).mock.calls.at(-1) ?? [];
      expect(reloaded?.frames).toHaveLength(40);
    });
  });

  it("extends late audio onto everything a footer-less stream decoded", async () => {
    // A stream that ends without its footer (a still-writing or cut-off file) is never
    // finalized; the player gets it as a first load plus appended deltas.
    const lesson = largeRecording(60, 4000, {
      id: "lesson",
      audioFile: "lesson.weba",
      audioSource: "external",
    });
    const encoded = await encodeRecordingToStream(lesson);
    const withoutFooter = encoded.slice(0, encoded.length - 1);
    const stream = streamingResponse(withoutFooter);
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
        const url = targetUrl(typeof input === "string" ? input : input.toString());
        if (url.endsWith("/lesson.ne")) return stream.response;
        if (url.endsWith("/lesson.weba")) {
          return fakeResponse(new Uint8Array([1, 2, 3]), { ok: true, contentType: "audio/webm" });
        }
        return fakeResponse(null, { ok: false, status: 404 });
      }),
    );
    const actions = makeActionsMock();
    const { result } = renderLoader(actions);

    await result.current.fetchNextEditorFile("https://example.com/lesson.ne");
    await waitFor(() => {
      expect(
        vi.mocked(actions.extendRecording).mock.calls.some(([recording]) => recording.audioBlob),
      ).toBe(true);
    });

    const [firstLoad] = vi.mocked(actions.loadRecording).mock.calls[0] ?? [];
    const appendedFrames = vi
      .mocked(actions.appendRecordingDelta)
      .mock.calls.reduce((count, [delta]) => count + delta.newFrames.length, 0);
    expect(appendedFrames).toBeGreaterThan(0);
    const [withAudio] = vi.mocked(actions.extendRecording).mock.calls.at(-1) ?? [];
    expect(withAudio?.audioBlob).toBeInstanceOf(Blob);
    expect(withAudio?.frames).toHaveLength((firstLoad?.frames.length ?? 0) + appendedFrames);
  });

  // Browsers get no reason phrase over HTTP/2 or HTTP/3, so `statusText` is always "".
  describe("a failed .ne fetch", () => {
    const failedResponse = (status: number, body?: unknown) =>
      ({
        ok: false,
        status,
        statusText: "",
        body: null,
        headers: { get: () => (body === undefined ? null : "application/json") },
        json: async () => {
          if (body === undefined) throw new SyntaxError("Unexpected end of JSON input");
          return body;
        },
      }) as unknown as Response;

    it("names the HTTP status", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn<() => Promise<Response>>(async () => failedResponse(404)),
      );
      const { result } = renderLoader(makeActionsMock());

      await expect(
        result.current.fetchNextEditorFile("https://example.com/typo.ne"),
      ).rejects.toThrow("HTTP 404");
      await waitFor(() => {
        expect(result.current.error).toMatch(/HTTP 404/);
      });
    });

    it("shows the reason the same-origin proxy gives", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn<() => Promise<Response>>(async () =>
          failedResponse(502, { error: "Upstream responded with HTTP 404." }),
        ),
      );
      const { result } = renderLoader(makeActionsMock());

      await expect(
        result.current.fetchNextEditorFile("https://example.com/typo.ne"),
      ).rejects.toThrow("Upstream responded with HTTP 404.");
    });
  });

  it("reports a URL that is not a .ne instead of leaving the editor blank", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderLoader(makeActionsMock());

    await expect(
      result.current.fetchNextEditorFile("https://example.com/lessons/intro/"),
    ).rejects.toThrow("URL does not point to a supported file (.ne)");

    await waitFor(() => {
      expect(result.current.error).toMatch(/supported file/);
    });
    expect(result.current.isLoading).toBe(false);
    // Fetching the same URL again cannot help.
    expect(result.current.retry).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops looking for sibling media once the lesson is left", async () => {
    // Three audio candidates: the configured URL, the stored file name, the .ne basename.
    const recording = createRecording({
      audioUrl: "https://cdn.example.com/hosted.weba",
      audioFile: "lesson.weba",
      audioSource: "external",
    });
    const neBytes = await encodeRecordingToStream(recording);
    let left = false;
    const requestedAfterLeaving: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input, init) => {
        const url = targetUrl(typeof input === "string" ? input : input.toString());
        if (left) requestedAfterLeaving.push(url);
        if (url.endsWith(".ne")) {
          return Promise.resolve(
            fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" }),
          );
        }
        // Audio downloads hang until the request is aborted, like a slow host.
        return new Promise<Response>((_, reject) => {
          const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
          if (init?.signal?.aborted) abort();
          init?.signal?.addEventListener("abort", abort);
        });
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, unmount } = renderLoader(makeActionsMock());

    await result.current.fetchNextEditorFile("https://example.com/intro-01.ne");
    await new Promise((resolve) => setTimeout(resolve, 10));
    left = true;
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Before, each remaining candidate was tried (and its proxy fallback) and reported as failed.
    expect(requestedAfterLeaving).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("adds every declared caption file, even two without a language tag", async () => {
    const recording = createRecording({
      id: "lesson",
      captionFiles: ["captions.vtt", "transcript.vtt"],
    });
    const neBytes = await encodeRecordingToStream(recording);
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
        const url = targetUrl(typeof input === "string" ? input : input.toString());
        if (url.endsWith(".ne")) {
          return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
        }
        if (url.endsWith("/captions.vtt") || url.endsWith("/transcript.vtt")) {
          return fakeResponse(vttBody(), { ok: true, contentType: "text/vtt" });
        }
        return fakeResponse(null, { ok: false, status: 404 });
      }),
    );
    const actions = makeActionsMock();
    const { result } = renderLoader(actions);

    await result.current.fetchNextEditorFile("https://example.com/lesson.ne");
    await waitFor(() => {
      expect(actions.addCaptionTrack).toHaveBeenCalledTimes(2);
    });

    const calls = vi.mocked(actions.addCaptionTrack).mock.calls;
    // Each track names the lesson it was fetched for, so the machine can drop it once
    // another lesson has opened by a route this loader does not see (the header import).
    expect(calls.map(([recordingId]) => recordingId)).toEqual(["lesson", "lesson"]);
    // ADD_CAPTION_TRACK replaces a track with the same id, so the ids must differ.
    const ids = calls.map(([, track]) => track.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("still tries the .ne basename VTT when a declared caption name is not a valid URL", async () => {
    const recording = createRecording({ captionFiles: ["http://[broken"] });
    const neBytes = await encodeRecordingToStream(recording);
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
        const url = targetUrl(typeof input === "string" ? input : input.toString());
        if (url.endsWith(".ne")) {
          return fakeResponse(neBytes, { ok: true, contentType: "application/octet-stream" });
        }
        if (url.endsWith("/intro-01.vtt")) {
          return fakeResponse(vttBody(), { ok: true, contentType: "text/vtt" });
        }
        return fakeResponse(null, { ok: false, status: 404 });
      }),
    );
    const actions = makeActionsMock();
    const { result } = renderLoader(actions);

    await result.current.fetchNextEditorFile("https://example.com/intro-01.ne");

    await waitFor(() => {
      expect(actions.addCaptionTrack).toHaveBeenCalledTimes(1);
    });
  });

  // The progressive path end to end: one load, then deltas in stream order, then the final
  // recording. At ~650 KB this lesson gets a delta at the 512 KB step and one at the end.
  it("hands a long lesson over as a load, ordered deltas and a final extend", async () => {
    const bytes = await encodeRecordingToStream(largeRecording(220, 4000, { id: "long" }));
    const stream = streamingResponse(bytes);
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => stream.response),
    );
    const actions = makeActionsMock();
    const { result } = renderLoader(actions);

    await result.current.fetchNextEditorFile("https://example.com/long.ne");

    const [loaded] = vi.mocked(actions.loadRecording).mock.calls[0] ?? [];
    const deltas = vi.mocked(actions.appendRecordingDelta).mock.calls.map(([delta]) => delta);
    expect(actions.loadRecording).toHaveBeenCalledTimes(1);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    const cursors = deltas.map((delta) => delta.cursor);
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    expect(new Set(cursors).size).toBe(cursors.length);
    const appended = deltas.reduce((count, delta) => count + delta.newFrames.length, 0);
    expect((loaded?.frames.length ?? 0) + appended).toBe(220);
    const [final] = vi.mocked(actions.extendRecording).mock.calls.at(-1) ?? [];
    expect(final?.frames).toHaveLength(220);
    expect(final?.streamFinalized).toBe(true);
  }, 15_000);

  it("sends nothing more from a stream once a newer URL load starts", async () => {
    const oldBytes = await encodeRecordingToStream(largeRecording(60, 4000, { id: "old" }));
    const newBytes = await encodeRecordingToStream(createRecording({ id: "new" }));
    const oldDownload = gate();
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        async (input, init) => {
          const url = targetUrl(typeof input === "string" ? input : input.toString());
          if (url.endsWith("/old.ne")) {
            return streamingResponse(oldBytes, {
              holdAfter: 64 * 1024,
              resume: oldDownload.opened,
              signal: init?.signal,
            }).response;
          }
          return fakeResponse(newBytes, { ok: true, contentType: "application/octet-stream" });
        },
      ),
    );
    const actions = makeActionsMock();
    const { result } = renderLoader(actions);

    const oldLoad = result.current.fetchNextEditorFile("https://example.com/old.ne");
    await waitFor(() => {
      expect(actions.loadRecording).toHaveBeenCalledTimes(1);
    });
    await result.current.fetchNextEditorFile("https://example.com/new.ne");
    oldDownload.open();
    await oldLoad;

    const loadedIds = vi.mocked(actions.loadRecording).mock.calls.map(([loaded]) => loaded.id);
    expect(loadedIds).toEqual(["old", "new"]);
    expect(actions.appendRecordingDelta).not.toHaveBeenCalled();
    expect(actions.extendRecording).not.toHaveBeenCalled();
  });
});
