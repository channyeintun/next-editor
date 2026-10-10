import type { CaptionTrack, Recording } from "../core/src";
import { decompressBinaryToRecording } from "./recordingCodecClient";
import { describeFailedResponse, fetchNextEditorUrl } from "./recordingFetch";
import { streamRecording, type RecordingStreamSink } from "./recordingStream";
import {
  fetchSiblingCaptions,
  findWorkingAudioBlob,
  findWorkingCameraUrl,
  withResolvedMediaUrls,
} from "./recordingSiblingMedia";

/** Where loadRecordingFromUrl hands a lesson over (the URL loader's editor actions). */
export interface RecordingLoadSink extends RecordingStreamSink {
  /** A caption file found beside the `.ne`, for the recording it loaded. */
  addCaptionTrack: (recordingId: string, track: CaptionTrack) => void;
  /**
   * Settles when the lesson's narration may start downloading. Without it, the narration
   * downloads as soon as the `.ne` has loaded; either way it waits no longer than
   * NARRATION_GATE_TIMEOUT_MS.
   */
  narrationGate?: () => Promise<void>;
}

// The longest the narration download waits for the sink's gate. The gate settles on its own
// (the editor chunk loads or fails, or the viewer presses Play); this only keeps a gate that
// never does from leaving the lesson without narration. Slow-4G phones take ~15 s for Monaco.
export const NARRATION_GATE_TIMEOUT_MS = 20_000;

/** Waits for `gate`, at most NARRATION_GATE_TIMEOUT_MS, and no longer once `signal` aborts. */
async function waitForNarrationGate(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  let stopWaiting!: () => void;
  const timeoutOrAbort = new Promise<void>((resolve) => {
    stopWaiting = resolve;
  });
  const timer = setTimeout(stopWaiting, NARRATION_GATE_TIMEOUT_MS);
  signal.addEventListener("abort", stopWaiting, { once: true });
  try {
    await Promise.race([gate.catch(() => {}), timeoutOrAbort]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stopWaiting);
  }
}

/**
 * Resolves external audio/camera media out-of-band, after the (now tiny) `.ne` itself has
 * loaded. Camera is probed first (cheap HEAD/ranged-GET) and audio's full download happens
 * after, folding in whatever the camera probe found instead of racing it. That download waits
 * for the sink's narration gate first; a camera fix found meanwhile is handed over before the
 * wait rather than held back by it, and audio then extends on top of it.
 */
async function resolveExternalMedia(
  recording: Recording,
  neUrl: string,
  signal: AbortSignal,
  sink: RecordingLoadSink,
): Promise<void> {
  let current = recording;
  let handedOver = recording;

  if (current.cameraFile || current.cameraUrl) {
    const cameraUrl = await findWorkingCameraUrl(current, neUrl, signal);
    if (cameraUrl) {
      current = { ...current, cameraUrl };
    }
  }

  const { narrationGate } = sink;
  const audio = await findWorkingAudioBlob(
    current,
    neUrl,
    signal,
    narrationGate
      ? async () => {
          if (current !== handedOver && !sink.isStale()) {
            sink.extend(current);
            handedOver = current;
          }
          await waitForNarrationGate(narrationGate(), signal);
        }
      : undefined,
  );
  if (audio) {
    current = { ...current, audioUrl: audio.url, audioBlob: audio.blob };
  }

  if (current !== handedOver && !sink.isStale()) {
    sink.extend(current);
  }
}

/**
 * Fetches the `.ne` at `url` and hands it to `sink` as it decodes: streamed when the body can
 * be, whole otherwise. Resolves once the lesson itself has loaded; its sibling captions and
 * external audio/camera keep resolving after that, until `signal` aborts. Nothing reaches the
 * sink once `sink.isStale()`. Rejects with why the fetch or the decode failed, or with an
 * AbortError when `signal` aborts the download.
 */
export async function loadRecordingFromUrl(
  url: string,
  signal: AbortSignal,
  sink: RecordingLoadSink,
): Promise<void> {
  const response = await fetchNextEditorUrl(url, { signal });

  if (!response.ok) {
    throw new Error(await describeFailedResponse(response));
  }

  if (sink.isStale()) return;

  // Stream + progressively decode straight from the response body. Cloning the
  // response here would tee the stream and buffer the *entire* file in the unread
  // branch — defeating streaming — so the body is consumed directly. The reader
  // only returns null before touching the body (not a readable stream), and the
  // body is then read whole. Once it has started reading, only a broken download
  // (a network TypeError) is retried by fetching the whole file again; a decode
  // error is final, since the whole-file decoder would reject the same bytes.
  let loaded: Recording | null = null;
  let bodyConsumed = false;
  try {
    loaded = await streamRecording(response, url, sink);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    console.warn("Streaming the recording failed, fetching it whole:", error);
    bodyConsumed = true;
  }

  if (sink.isStale()) return;

  if (!loaded) {
    const source = bodyConsumed ? await fetchNextEditorUrl(url, { signal }) : response;
    const bytes = new Uint8Array(await source.arrayBuffer());
    loaded = withResolvedMediaUrls(await decompressBinaryToRecording(bytes), url);
    // A newer load may have started while the whole file downloaded and decoded.
    if (sink.isStale()) return;
    sink.load(loaded);
  }

  const recordingId = loaded.id;
  fetchSiblingCaptions(url, loaded.captionFiles, signal)
    .then((tracks) => {
      if (!sink.isStale()) {
        for (const track of tracks) sink.addCaptionTrack(recordingId, track);
      }
    })
    .catch(() => {});

  // Externalized audio/camera resolve out-of-band, after the (now tiny) `.ne` finished.
  resolveExternalMedia(loaded, url, signal, sink).catch((error: unknown) => {
    // Leaving or replacing the lesson aborts these downloads; that is not a failure.
    if (!signal.aborted) console.warn("Resolving the lesson's sibling media failed:", error);
  });
}
