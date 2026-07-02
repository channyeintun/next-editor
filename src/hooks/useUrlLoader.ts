import { useState } from "react";
import { useNextEditorActions } from "./useNextEditorContext";
import {
  decodeBase64ToRecordings,
  decompressBinaryToRecordings,
} from "../storage/recordingCodecClient";
import {
  audioMimeFromFilename,
  createStreamingRecordingReader,
} from "../storage/streamingRecordingCodec";
import { createImportedCameraObjectUrl } from "../storage/cameraVideoUrl";
import { decodeBase64 } from "../core/src/utils/base64";
import type { CaptionTrack, Recording } from "../core/src";

const SAME_ORIGIN_PROXY_PATH = "/api/proxy";
const MISSING_PROXY_STATUS_CODES = new Set([404, 405, 501]);

// Decode the accumulated stream into a (partial) recording roughly every this many bytes of
// downloaded bytes, so playback can start before the whole `.ne` file has arrived.
const STREAM_DECODE_INTERVAL_BYTES = 512 * 1024;
const SCR3_MAGIC_BYTES = new Uint8Array([0x53, 0x43, 0x52, 0x33]);

function concatByteChunks(parts: Uint8Array[], totalLength?: number): Uint8Array {
  const total = totalLength ?? parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

function startsWithScr3(bytes: Uint8Array): boolean {
  return (
    bytes.length >= SCR3_MAGIC_BYTES.length &&
    SCR3_MAGIC_BYTES.every((value, index) => bytes[index] === value)
  );
}

/**
 * Resolve external media references (`cameraFile` / `audioFile`) into absolute URLs relative to
 * the original `.ne` URL, so a sibling video plays via a native `<video src>` and sibling audio
 * can be fetched for playback. Resolves against the user-facing `.ne` URL (not any same-origin
 * proxy URL) so the media is fetched from its real host.
 */
function withResolvedMediaUrls(recording: Recording, baseUrl: string | undefined): Recording {
  if (!baseUrl) {
    return recording;
  }

  let resolved = recording;
  if (recording.cameraFile && !recording.cameraUrl) {
    try {
      resolved = { ...resolved, cameraUrl: new URL(recording.cameraFile, baseUrl).toString() };
    } catch {
      // Unresolvable reference — play without camera.
    }
  }
  if (recording.audioFile && !recording.audioUrl) {
    try {
      resolved = { ...resolved, audioUrl: new URL(recording.audioFile, baseUrl).toString() };
    } catch {
      // Unresolvable reference — play without audio.
    }
  }
  return resolved;
}

async function fetchVttFile(url: string): Promise<CaptionTrack | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim().startsWith("WEBVTT")) return null;
    const { parseVtt, inferLanguageFromFilename } = await import("../captions/parseCaptions");
    const cues = parseVtt(text);
    if (cues.length === 0) return null;
    const lang = inferLanguageFromFilename(url) ?? "en";
    return {
      id: `${lang}-sibling`,
      language: lang,
      label: lang.toUpperCase(),
      cues,
      default: true,
    };
  } catch {
    return null;
  }
}

/**
 * Loads caption tracks the recording explicitly declares via `captionFiles`, resolved relative
 * to the `.ne` URL. Captions are never guessed from sibling filenames — HTTP has no directory
 * listing, so a recording must name its companion VTTs to have them auto-load.
 */
async function fetchSiblingCaptions(
  neUrl: string,
  captionFiles?: string[],
): Promise<CaptionTrack[]> {
  if (!captionFiles || captionFiles.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(
    captionFiles.map((file) => fetchVttFile(new URL(file, neUrl).toString())),
  );
  const tracks: CaptionTrack[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      if (tracks.length > 0) result.value.default = false;
      tracks.push(result.value);
    }
  }
  return tracks;
}

function buildSameOriginProxyUrl(targetUrl: string): string {
  const proxyUrl = new URL(SAME_ORIGIN_PROXY_PATH, window.location.origin);
  proxyUrl.searchParams.set("url", targetUrl);
  return proxyUrl.toString();
}

async function fetchNextEditorUrl(url: string): Promise<Response> {
  const urlObj = new URL(url);

  if (urlObj.origin === window.location.origin) {
    return fetch(url);
  }

  const proxyUrl = buildSameOriginProxyUrl(url);

  try {
    const proxyResponse = await fetch(proxyUrl);

    // Hosts without a real `/api/proxy` endpoint (static/SPA deploys) rewrite the
    // unknown path to the app shell and answer 200 with `text/html`. That HTML is
    // not a recording, so treat it as "proxy unavailable" and fall through to the
    // direct cross-origin fetch (which needs CORS on the recording's host).
    const isSpaFallback = (proxyResponse.headers.get("content-type") ?? "").includes("text/html");

    if (
      !isSpaFallback &&
      (proxyResponse.ok || !MISSING_PROXY_STATUS_CODES.has(proxyResponse.status))
    ) {
      return proxyResponse;
    }
  } catch (error) {
    console.warn("Same-origin proxy request failed, falling back to direct fetch:", error);
  }

  return fetch(url);
}

export const useUrlLoader = () => {
  const [isLoading, setIsLoading] = useState(false);
  // Surfaces a human-readable load failure to the UI instead of a blocking `alert()`,
  // so callers can render an inline, themeable error panel (with retry) in context.
  const [error, setError] = useState<string | null>(null);
  const { loadRecording, extendRecording, addCaptionTrack } = useNextEditorActions();

  const isNextEditorUrl = (url: string): boolean => {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.toLowerCase();
      return pathname.endsWith(".ne");
    } catch {
      return false;
    }
  };

  const importNextEditorFile = async (file: File, videoFile?: File, audioFile?: File) => {
    // Attach dropped sibling media: camera video as an object URL so playback streams it
    // directly, audio directly as the playback blob (a `File` is a `Blob`).
    const attachVideo = (recording: Recording): Recording => {
      let result = recording;
      if (result.cameraFile && videoFile) {
        result = { ...result, cameraUrl: createImportedCameraObjectUrl(videoFile) };
      }
      if (result.audioFile && audioFile && !(result.audioBlob instanceof Blob)) {
        result = { ...result, audioBlob: audioFile };
      }
      return result;
    };
    try {
      setIsLoading(true);
      setError(null);
      if (file.name.endsWith(".ne")) {
        const bytes = new Uint8Array(await file.arrayBuffer());

        if (bytes.length === 0) {
          throw new Error("File appears to be empty or corrupted");
        }

        if (startsWithScr3(bytes)) {
          const recordings = await decompressBinaryToRecordings(bytes);
          if (recordings.length > 0) {
            loadRecording(attachVideo(recordings[0]));
          }
          return;
        }

        const text = new TextDecoder().decode(bytes);
        const trimmedText = text.trim();

        if (!trimmedText) {
          throw new Error("File appears to be empty or corrupted");
        }

        // Relaxed validation: Allow whitespace/newlines and check general format
        // Strip whitespace for the check
        const stripped = trimmedText.replace(/\s/g, "");
        const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
        if (!base64Pattern.test(stripped)) {
          throw new Error("File does not contain valid base64 data");
        }

        const recordings = await decodeBase64ToRecordings(stripped);

        if (recordings.length > 0) {
          loadRecording(attachVideo(recordings[0]));
        }
      }
    } catch (err) {
      console.error("Failed to import file:", err);
      setError(`Failed to import file: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setIsLoading(false);
    }
  };

  const loadRecordingFromBase64Text = async (
    text: string,
    baseUrl?: string,
  ): Promise<Recording | null> => {
    const stripped = text.replace(/\s/g, "");
    if (!stripped) {
      throw new Error("File appears to be empty or corrupted");
    }
    const recordings = await decodeBase64ToRecordings(stripped);
    if (recordings.length > 0) {
      const resolved = withResolvedMediaUrls(recordings[0], baseUrl);
      loadRecording(resolved);
      return resolved;
    }
    return null;
  };

  const loadRecordingFromBinaryBytes = async (
    bytes: Uint8Array,
    baseUrl?: string,
  ): Promise<Recording | null> => {
    if (!startsWithScr3(bytes)) {
      throw new Error("File does not contain a valid SCR3 recording stream");
    }

    const recordings = await decompressBinaryToRecordings(bytes);
    if (recordings.length > 0) {
      const resolved = withResolvedMediaUrls(recordings[0], baseUrl);
      loadRecording(resolved);
      return resolved;
    }
    return null;
  };

  /**
   * Streams a `.ne` response and progressively decodes ever-larger prefixes of the SCR3 stream,
   * so playback can begin before the whole file has downloaded. The first decodable prefix is
   * loaded; subsequent prefixes extend it in place (see `extendRecording`). Falls back to the
   * caller for whole-file decoding when the body is not streamable.
   */
  const streamRecordingFromResponse = async (
    response: Response,
    baseUrl?: string,
  ): Promise<Recording | null> => {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") {
      return null;
    }

    const reader = body.getReader();
    const textDecoder = new TextDecoder();
    const sniffParts: Uint8Array[] = [];
    let sniffLength = 0;
    let cleanBase64 = "";
    let decodedBase64Len = 0;
    const streamReader = createStreamingRecordingReader();
    let lastDecodeLength = 0;
    let loadedOnce = false;
    let latestRecording: Recording | null = null;

    const applyRecording = (
      recording: Awaited<ReturnType<typeof decodeBase64ToRecordings>>[0] | null | undefined,
    ) => {
      if (!recording) {
        return;
      }

      const resolved = withResolvedMediaUrls(recording, baseUrl);
      // Track the newest decoded snapshot — the caller needs the *final* recording
      // (for sibling captions/audio), not the first playable prefix.
      latestRecording = resolved;

      if (!loadedOnce) {
        loadRecording(resolved);
        loadedOnce = true;
        setIsLoading(false);
        return;
      }

      extendRecording(resolved);
    };

    // Both `.ne` encodings — raw binary and base64-wrapped — feed the same incremental
    // reader, which decodes only newly-arrived segments. A prefix that isn't decodable yet
    // simply yields `null` (no throw); a thrown error is genuine corruption/desync and
    // propagates to the whole-file fallback in `fetchNextEditorFile`.
    const applyStreamed = () => {
      applyRecording(streamReader.getRecording());
    };

    // Decode whole 4-character base64 groups into bytes and push them to the reader.
    // Base64 padding only appears in the final group, so every mid-stream slice is a clean,
    // independently-decodable group boundary.
    const feedBase64 = () => {
      const boundary = cleanBase64.length - (cleanBase64.length % 4);
      if (boundary <= decodedBase64Len) {
        return;
      }
      const bytes = decodeBase64(cleanBase64.slice(decodedBase64Len, boundary));
      decodedBase64Len = boundary;
      if (bytes.length > 0) {
        streamReader.push(bytes);
      }
    };

    const ingestChunk = (mode: "binary" | "text", bytes: Uint8Array) => {
      if (mode === "binary") {
        streamReader.push(bytes);
        return;
      }
      cleanBase64 += textDecoder.decode(bytes, { stream: true }).replace(/\s/g, "");
      feedBase64();
    };

    try {
      let streamMode: "binary" | "text" | null = null;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        if (!value || value.length === 0) {
          continue;
        }

        if (streamMode === null) {
          sniffParts.push(value);
          sniffLength += value.length;
          if (sniffLength < SCR3_MAGIC_BYTES.length) {
            continue;
          }

          const sniffBytes = concatByteChunks(sniffParts, sniffLength);
          streamMode = startsWithScr3(sniffBytes) ? "binary" : "text";
          ingestChunk(streamMode, sniffBytes);
          sniffParts.length = 0;
          sniffLength = 0;
        } else {
          ingestChunk(streamMode, value);
        }

        const downloaded = streamReader.byteLength();
        if (downloaded - lastDecodeLength >= STREAM_DECODE_INTERVAL_BYTES) {
          lastDecodeLength = downloaded;
          applyStreamed();
        }
      }

      if (streamMode === null && sniffLength > 0) {
        const sniffBytes = concatByteChunks(sniffParts, sniffLength);
        streamMode = startsWithScr3(sniffBytes) ? "binary" : "text";
        ingestChunk(streamMode, sniffBytes);
      }

      if (streamMode === "text") {
        // Flush the text decoder's buffered tail, then decode the final (padded) group.
        cleanBase64 += textDecoder.decode().replace(/\s/g, "");
        feedBase64();
      }
      applyStreamed();
    } finally {
      reader.releaseLock();
    }

    if (!loadedOnce) {
      throw new Error("No valid recording found in stream");
    }
    return latestRecording;
  };

  /**
   * Fetches a recording's external audio (a sibling file referenced by `audioFile` /
   * `audioUrl`) and attaches it via `extendRecording`, which spawns/updates the playback
   * audio actor. Runs after the `.ne` itself has fully loaded, so the audio bytes never
   * flow through the progressive stream decoder — the whole point of externalizing them.
   */
  const attachExternalAudio = async (recording: Recording) => {
    const url = recording.audioUrl;
    if (!url || recording.audioBlob instanceof Blob) {
      return;
    }
    try {
      const response = await fetchNextEditorUrl(url);
      if (!response.ok) {
        console.warn(`External audio fetch failed (${response.status}): ${url}`);
        return;
      }
      const raw = await response.blob();
      if (raw.size === 0) {
        return;
      }
      // Some hosts serve sibling audio without a usable content type; fall back to the
      // extension-derived MIME so `decodeAudioData` and track metadata behave.
      const type =
        (raw.type && !raw.type.includes("text/html") ? raw.type : undefined) ??
        audioMimeFromFilename(recording.audioFile ?? url) ??
        "audio/webm";
      const audioBlob = raw.type === type ? raw : new Blob([raw], { type });
      extendRecording({ ...recording, audioBlob });
    } catch (err) {
      console.warn("Failed to fetch external audio:", err);
    }
  };

  const fetchNextEditorFile = async (url: string) => {
    if (!isNextEditorUrl(url)) {
      throw new Error("URL does not point to a supported file (.ne)");
    }

    try {
      setIsLoading(true);
      setError(null);
      const response = await fetchNextEditorUrl(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }

      // Stream + progressively decode straight from the response body. Cloning the
      // response here would tee the stream and buffer the *entire* file in the unread
      // branch — defeating streaming — so the body is consumed directly. The reader
      // only returns `false` before touching the body (not a readable stream); any
      // failure after it starts reading throws, in which case the body is already
      // drained and the whole-file fallback re-fetches the URL.
      let loaded: Recording | null = null;
      let bodyConsumed = false;
      try {
        loaded = await streamRecordingFromResponse(response, url);
      } catch {
        bodyConsumed = true;
      }

      if (!loaded) {
        const source = bodyConsumed ? await fetchNextEditorUrl(url) : response;
        const bytes = new Uint8Array(await source.arrayBuffer());
        if (startsWithScr3(bytes)) {
          loaded = await loadRecordingFromBinaryBytes(bytes, url);
        } else {
          loaded = await loadRecordingFromBase64Text(new TextDecoder().decode(bytes).trim(), url);
        }
      }

      fetchSiblingCaptions(url, loaded?.captionFiles)
        .then((tracks) => {
          for (const track of tracks) addCaptionTrack(track);
        })
        .catch(() => {});

      // Externalized audio loads out-of-band, after the (now tiny) `.ne` finished.
      if (loaded) {
        void attachExternalAudio(loaded);
      }
    } catch (err) {
      console.error("Failed to load tutorial from URL:", err);
      setError(`Failed to load tutorial: ${err instanceof Error ? err.message : "Unknown error"}`);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    fetchNextEditorFile,
    importNextEditorFile,
    isNextEditorUrl,
    isLoading,
    error,
    clearError: () => setError(null),
  };
};
