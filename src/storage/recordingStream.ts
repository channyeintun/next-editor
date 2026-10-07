import type { Recording, RecordingStreamDelta } from "../core/src";
import { createStreamingRecordingReader } from "./streamingRecordingCodec";
import {
  hydrateDecodedRecordingWorkspaceAssets,
  persistDecodedWorkspaceAssets,
  stripRecordingWorkspaceAssets,
} from "./recordingWorkspaceAssets";
import { withResolvedMediaUrls } from "./recordingSiblingMedia";

// Once the first playable prefix has loaded (tried on every chunk until then), hand newly
// decoded records to the player at a chunk that arrives this long after the last hand-over.
// The first load holds only cluster 0's frames; its workspace, runtime, cursor and preview
// segments decode a few KB later, and a byte interval alone held them back until the next
// 512 KB, the end of the stream for a short lesson. Appending a delta is one machine event,
// so a few a second cost little.
const STREAM_DELIVERY_INTERVAL_MS = 250;
// ...and at least every this many downloaded bytes, however fast they arrive.
const STREAM_DECODE_INTERVAL_BYTES = 512 * 1024;

/** Where streamRecording hands a `.ne` over as it decodes (the URL loader's editor actions). */
export interface RecordingStreamSink {
  /** True once a newer load has superseded this one: nothing more is handed over then. */
  isStale: () => boolean;
  /** The first playable prefix, with every record decoded so far. */
  load: (recording: Recording) => void;
  /** The records decoded since the last hand-over. */
  appendDelta: (delta: RecordingStreamDelta) => void;
  /** The complete recording, once the footer is in or the body has ended without one. */
  extend: (recording: Recording) => void;
}

/**
 * Streams a `.ne` response and progressively decodes ever-larger prefixes of the SCR3 stream,
 * so playback can begin before the whole file has downloaded. The first decodable prefix is
 * loaded; subsequent intervals append only newly decoded records. A complete immutable
 * recording is constructed again only at the end: at finalization, or when the body ends
 * without a footer. Returns null, without touching the body, when it is not streamable, so the
 * caller decodes the whole file instead.
 */
export async function streamRecording(
  response: Response,
  baseUrl: string,
  sink: RecordingStreamSink,
): Promise<Recording | null> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    return null;
  }

  const reader = body.getReader();
  const streamReader = createStreamingRecordingReader();
  let lastDecodeLength = 0;
  let lastDecodeAt = 0;
  let loadedOnce = false;
  let appliedFinalSnapshot = false;
  let latestRecording: Recording | null = null;

  const resolveRecording = (recording: Recording | null | undefined): Recording | null => {
    if (!recording) {
      return null;
    }

    const resolved = withResolvedMediaUrls(recording, baseUrl);
    // Track the newest complete snapshot (the first prefix, then the final recording) —
    // the caller needs the final one (for sibling captions/audio).
    latestRecording = resolved;
    return resolved;
  };

  const applyStreamed = async (endOfStream: boolean) => {
    if (!loadedOnce) {
      const decoded = streamReader.getRecording();
      // Mid-stream, wait for a prefix with a frame to show; at the end, load whatever decoded.
      if (!decoded || (!endOfStream && decoded.frames.length === 0)) return;
      const hydrated = await hydrateDecodedRecordingWorkspaceAssets(decoded);
      // A newer load may have started during the IndexedDB round trip.
      if (sink.isStale()) return;
      const resolved = resolveRecording(hydrated);
      if (!resolved) return;
      sink.load(resolved);
      loadedOnce = true;
      // The initial snapshot already contains every record decoded so far. Advance
      // the reader's delivery cursors without sending those records a second time.
      streamReader.readDelta();
      appliedFinalSnapshot = streamReader.isFinalized();
      return;
    }

    const delta = streamReader.readDelta();
    if (delta) {
      await persistDecodedWorkspaceAssets(delta.newWorkspaceAssets);
      if (sink.isStale()) return;
      sink.appendDelta({ ...delta, newWorkspaceAssets: [] });
    }

    // Settle on the complete recording once the footer is in, or once the body ends
    // without one (a still-writing or cut-off file): the caller extends late media onto
    // `latestRecording`, which must hold every decoded record, not the first prefix.
    if ((endOfStream || streamReader.isFinalized()) && !appliedFinalSnapshot) {
      const decoded = streamReader.getRecording();
      const finalRecording = resolveRecording(
        decoded ? stripRecordingWorkspaceAssets(decoded) : null,
      );
      if (finalRecording) {
        sink.extend(finalRecording);
        appliedFinalSnapshot = true;
      }
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      if (!value || value.length === 0) {
        continue;
      }

      streamReader.push(value);

      const downloaded = streamReader.byteLength();
      const now = performance.now();
      if (
        !loadedOnce ||
        now - lastDecodeAt >= STREAM_DELIVERY_INTERVAL_MS ||
        downloaded - lastDecodeLength >= STREAM_DECODE_INTERVAL_BYTES
      ) {
        lastDecodeLength = downloaded;
        lastDecodeAt = now;
        await applyStreamed(false);
      }
    }

    await applyStreamed(true);
  } catch (error) {
    // Stop the download rather than leave it stalled and open until garbage collection.
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (!loadedOnce) {
    throw new Error("No valid recording found in stream");
  }
  return latestRecording;
}
