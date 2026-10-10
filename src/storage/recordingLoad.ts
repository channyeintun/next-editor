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
}

/**
 * Resolves external audio/camera media out-of-band, after the (now tiny) `.ne` itself has
 * loaded. Camera is probed first (cheap HEAD/ranged-GET) so a single `extend` can carry both
 * fixes — audio's full download happens after, folding in whatever the camera probe found
 * instead of racing it.
 */
async function resolveExternalMedia(
  recording: Recording,
  neUrl: string,
  signal: AbortSignal,
  sink: RecordingLoadSink,
): Promise<void> {
  let current = recording;

  if (current.cameraFile || current.cameraUrl) {
    const cameraUrl = await findWorkingCameraUrl(current, neUrl, signal);
    if (cameraUrl) {
      current = { ...current, cameraUrl };
    }
  }

  const audio = await findWorkingAudioBlob(current, neUrl, signal);
  if (audio) {
    current = { ...current, audioUrl: audio.url, audioBlob: audio.blob };
  }

  if (current !== recording && !sink.isStale()) {
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
