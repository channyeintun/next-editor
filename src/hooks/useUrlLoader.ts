import { useState, useRef, useEffect } from "react";
import { useNextEditorActions } from "./useNextEditorContext";
import { decompressBinaryToRecording } from "../storage/recordingCodecClient";
import { createStreamingRecordingReader } from "../storage/streamingRecordingCodec";
import {
  attachCompanionMedia,
  decodeRecordingFile,
  selectRecordingFiles,
} from "../storage/RecordingStorage";
import {
  hydrateDecodedRecordingWorkspaceAssets,
  persistDecodedWorkspaceAssets,
  stripRecordingWorkspaceAssets,
} from "../storage/recordingWorkspaceAssets";
import { describeFailedResponse, fetchNextEditorUrl } from "../storage/recordingFetch";
import {
  fetchSiblingCaptions,
  findWorkingAudioBlob,
  findWorkingCameraUrl,
  withResolvedMediaUrls,
} from "../storage/recordingSiblingMedia";
import { isNextEditorUrl } from "../utils/recordingUrl";
import type { Recording } from "../core/src";

// Once the first playable prefix has loaded (tried on every chunk until then), hand newly
// decoded records to the player roughly every this many downloaded bytes.
const STREAM_DECODE_INTERVAL_BYTES = 512 * 1024;

interface LoadFailure {
  /** Human-readable reason, shown in the editor's inline error panel. */
  message: string;
  /** The URL that failed, so it can be retried; null for a file, which cannot be fetched again. */
  url: string | null;
}

export type UrlLoader = ReturnType<typeof useUrlLoader>;

/**
 * Loads a lesson from a URL or a dropped/picked `.ne` file into the editor. One instance serves
 * every entry point of an editor surface (the `?url=` query and drag-and-drop), so a newer load of
 * either kind supersedes an older one: its requests are aborted and its late results dropped.
 */
export const useUrlLoader = () => {
  const [isLoading, setIsLoading] = useState(false);
  // Surfaces a human-readable load failure to the UI instead of a blocking `alert()`,
  // so callers can render an inline, themeable error panel (with retry) in context.
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const { loadRecording, extendRecording, appendRecordingDelta, addCaptionTrack } =
    useNextEditorActions();
  const generationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  /** Starts a load that supersedes the previous one: aborts its requests and makes it stale. */
  const beginLoad = () => {
    const generation = ++generationRef.current;
    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setIsLoading(true);
    setFailure(null);
    return {
      signal: abortController.signal,
      isStale: () => generationRef.current !== generation,
    };
  };

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  /**
   * Loads the `.ne` among files dropped together, pairing it with the camera video and audio
   * among them the way the file picker does. Files without a `.ne` are not a lesson: they are
   * left alone and do not interrupt a load in progress.
   */
  const importNextEditorFile = async (files: File[]) => {
    const selection = selectRecordingFiles(files);
    if (!selection) return;
    const { isStale } = beginLoad();
    try {
      const recording = await decodeRecordingFile(selection.neFile);
      if (!isStale()) {
        loadRecording(attachCompanionMedia(recording, selection));
      }
    } catch (err) {
      if (isStale()) return;
      console.error("Failed to import file:", err);
      setFailure({
        message: `Failed to import file: ${err instanceof Error ? err.message : "Unknown error"}`,
        url: null,
      });
    } finally {
      if (!isStale()) {
        setIsLoading(false);
      }
    }
  };

  const loadRecordingFromBinaryBytes = async (
    bytes: Uint8Array,
    baseUrl?: string,
  ): Promise<Recording> => {
    const resolved = withResolvedMediaUrls(await decompressBinaryToRecording(bytes), baseUrl);
    loadRecording(resolved);
    return resolved;
  };

  /**
   * Streams a `.ne` response and progressively decodes ever-larger prefixes of the SCR3 stream,
   * so playback can begin before the whole file has downloaded. The first decodable prefix is
   * loaded; subsequent intervals append only newly decoded records. A complete immutable
   * recording is constructed again only at the end: at finalization, or when the body ends
   * without a footer. Falls back to the caller for whole-file decoding when the body is not
   * streamable.
   */
  const streamRecordingFromResponse = async (
    response: Response,
    baseUrl: string,
    isStale: () => boolean,
  ): Promise<Recording | null> => {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") {
      return null;
    }

    const reader = body.getReader();
    const streamReader = createStreamingRecordingReader();
    let lastDecodeLength = 0;
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
        if (isStale()) return;
        const resolved = resolveRecording(hydrated);
        if (!resolved) return;
        loadRecording(resolved);
        loadedOnce = true;
        setIsLoading(false);
        // The initial snapshot already contains every record decoded so far. Advance
        // the reader's delivery cursors without sending those records a second time.
        streamReader.readDelta();
        appliedFinalSnapshot = streamReader.isFinalized();
        return;
      }

      const delta = streamReader.readDelta();
      if (delta) {
        await persistDecodedWorkspaceAssets(delta.newWorkspaceAssets);
        if (isStale()) return;
        appendRecordingDelta({ ...delta, newWorkspaceAssets: [] });
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
          extendRecording(finalRecording);
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
        if (!loadedOnce || downloaded - lastDecodeLength >= STREAM_DECODE_INTERVAL_BYTES) {
          lastDecodeLength = downloaded;
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
  };

  /**
   * Resolves external audio/camera media out-of-band, after the (now tiny) `.ne` itself has
   * loaded. Camera is probed first (cheap HEAD/ranged-GET) so a single `extendRecording` can
   * carry both fixes — audio's full download happens after, folding in whatever the camera
   * probe found instead of racing it.
   */
  const resolveExternalMedia = async (
    recording: Recording,
    neUrl: string | undefined,
    isStale: () => boolean,
    signal: AbortSignal,
  ) => {
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

    if (current !== recording && !isStale()) {
      extendRecording(current);
    }
  };

  const fetchNextEditorFile = async (url: string) => {
    const { signal, isStale } = beginLoad();

    if (!isNextEditorUrl(url)) {
      // Reported like any other failure: a `?url=` that is not a lesson must not leave a blank
      // editor. Retry is not offered, since fetching the same URL again cannot help.
      const message = "URL does not point to a supported file (.ne)";
      setFailure({ message: `Failed to load tutorial: ${message}`, url: null });
      setIsLoading(false);
      throw new Error(message);
    }

    try {
      const response = await fetchNextEditorUrl(url, { signal });

      if (!response.ok) {
        throw new Error(await describeFailedResponse(response));
      }

      if (isStale()) return;

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
        loaded = await streamRecordingFromResponse(response, url, isStale);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        console.warn("Streaming the recording failed, fetching it whole:", error);
        bodyConsumed = true;
      }

      if (isStale()) return;

      if (!loaded) {
        const source = bodyConsumed ? await fetchNextEditorUrl(url, { signal }) : response;
        const bytes = new Uint8Array(await source.arrayBuffer());
        loaded = await loadRecordingFromBinaryBytes(bytes, url);
      }

      if (isStale()) return;

      const recordingId = loaded.id;
      fetchSiblingCaptions(url, loaded.captionFiles, signal)
        .then((tracks) => {
          if (!isStale()) {
            for (const track of tracks) addCaptionTrack(recordingId, track);
          }
        })
        .catch(() => {});

      // Externalized audio/camera resolve out-of-band, after the (now tiny) `.ne` finished.
      if (loaded && !isStale()) {
        resolveExternalMedia(loaded, url, isStale, signal).catch((error: unknown) => {
          // Leaving or replacing the lesson aborts these downloads; that is not a failure.
          if (!signal.aborted) console.warn("Resolving the lesson's sibling media failed:", error);
        });
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      if (isStale()) return;
      console.error("Failed to load tutorial from URL:", err);
      setFailure({
        message: `Failed to load tutorial: ${err instanceof Error ? err.message : "Unknown error"}`,
        url,
      });
      throw err;
    } finally {
      if (!isStale()) {
        setIsLoading(false);
      }
    }
  };

  const failedUrl = failure?.url;

  return {
    fetchNextEditorFile,
    importNextEditorFile,
    isNextEditorUrl,
    isLoading,
    error: failure?.message ?? null,
    /** Repeats a failed URL load; undefined when the last failure was a file. */
    retry: failedUrl
      ? () => {
          // The loader records a new failure itself; this only keeps it off the console as an
          // unhandled rejection.
          fetchNextEditorFile(failedUrl).catch(() => {});
        }
      : undefined,
    clearError: () => setFailure(null),
  };
};
