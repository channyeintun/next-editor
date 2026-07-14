import { useState, useRef, useEffect } from "react";
import { useNextEditorActions } from "./useNextEditorContext";
import { decompressBinaryToRecordings } from "../storage/recordingCodecClient";
import {
  audioMimeFromFilename,
  createStreamingRecordingReader,
} from "../storage/streamingRecordingCodec";
import { createImportedCameraObjectUrl } from "../storage/cameraVideoUrl";
import type { CaptionTrack, Recording } from "../core/src";

const SAME_ORIGIN_PROXY_PATH = "/api/proxy";
const MISSING_PROXY_STATUS_CODES = new Set([404, 405, 501]);

// Decode the accumulated stream into a (partial) recording roughly every this many bytes of
// downloaded bytes, so playback can start before the whole `.ne` file has arrived.
const STREAM_DECODE_INTERVAL_BYTES = 512 * 1024;

/** Extension (no dot) of a filename, or undefined if it has none. */
function fileExtension(filename: string | undefined): string | undefined {
  if (!filename) return undefined;
  return /\.([^./]+)$/.exec(filename)?.[1];
}

/** `<neBasename>.<ext>` resolved against the `.ne` URL, e.g. `intro-01.ne` -> `intro-01.weba`. */
function neBasenameMediaUrl(neUrl: string, ext: string): string | null {
  try {
    const url = new URL(neUrl);
    const slash = url.pathname.lastIndexOf("/");
    const base = url.pathname.slice(slash + 1).replace(/\.ne$/i, "");
    if (!base) return null;
    url.pathname = `${url.pathname.slice(0, slash + 1)}${base}.${ext}`;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Ordered, deduplicated candidate URLs for a media kind (audio/camera), so a renamed/re-hosted
 * `.ne` can still find its media: (1) a configured URL persisted on the recording, (2) the
 * stored sibling filename resolved against the `.ne` URL, (3) the `.ne` file's own basename
 * with the stored (or default) extension — covers the user renaming `lesson.ne`+`lesson.weba`
 * to `intro-01.ne`+`intro-01.weba` together. Returns `[]` when the recording declares no media
 * of this kind at all (never invents media that wasn't referenced). `declaredExternal` marks a
 * kind the recording declares external without naming a file (`audioSource === "external"` from
 * an older export that omitted `audioFile`) — the basename candidate still applies then.
 */
function buildMediaCandidates(
  storedUrl: string | undefined,
  storedFile: string | undefined,
  baseUrl: string | undefined,
  defaultExt: string,
  declaredExternal = false,
): string[] {
  if (!storedUrl && !storedFile && !declaredExternal) {
    return [];
  }
  const candidates: string[] = [];
  if (storedUrl) {
    // The stored URL may be relative to the `.ne` — resolve it against `baseUrl` like the
    // other candidates so downstream `new URL(...)` calls don't throw on a bare relative
    // string. Absolute URLs are unaffected by resolving against a base.
    try {
      const resolved = baseUrl ? new URL(storedUrl, baseUrl) : new URL(storedUrl);
      candidates.push(resolved.toString());
    } catch {
      // Unresolvable (relative with no baseUrl, or malformed) — skip this candidate.
    }
  }
  if (storedFile && baseUrl) {
    try {
      candidates.push(new URL(storedFile, baseUrl).toString());
    } catch {
      // Unresolvable reference — skip this candidate.
    }
  }
  if (baseUrl) {
    const basenameUrl = neBasenameMediaUrl(baseUrl, fileExtension(storedFile) ?? defaultExt);
    if (basenameUrl) {
      candidates.push(basenameUrl);
    }
  }
  return Array.from(new Set(candidates));
}

/**
 * Resolve external media references (`cameraFile` / `audioFile`) into absolute URLs relative to
 * the original `.ne` URL, so a sibling video plays via a native `<video src>` and sibling audio
 * can be fetched for playback. Resolves against the user-facing `.ne` URL (not any same-origin
 * proxy URL) so the media is fetched from its real host. This is the fast, unverified happy
 * path — {@link resolveExternalMedia} falls back to the `.ne` basename out-of-band when this
 * guess turns out to be wrong (renamed/re-hosted media).
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
 * to the `.ne` URL. Captions are never guessed from sibling filenames when a recording declares
 * none at all — HTTP has no directory listing, so a recording must name its companion VTTs to
 * have them auto-load. But when captions *are* declared and every one 404s (the same rename case
 * handled for audio/camera), `<neBasename>.vtt` is tried as a last-ditch fallback candidate
 * (mirrors `buildMediaCandidates`, kept to a single candidate since captions are optional and
 * multi-language guessing would be over-engineering for this low-priority case).
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

  if (tracks.length === 0) {
    const basenameUrl = neBasenameMediaUrl(neUrl, "vtt");
    if (
      basenameUrl &&
      !captionFiles.some((file) => new URL(file, neUrl).toString() === basenameUrl)
    ) {
      const track = await fetchVttFile(basenameUrl);
      if (track) tracks.push(track);
    }
  }

  return tracks;
}

function buildSameOriginProxyUrl(targetUrl: string): string {
  const proxyUrl = new URL(SAME_ORIGIN_PROXY_PATH, window.location.origin);
  proxyUrl.searchParams.set("url", targetUrl);
  return proxyUrl.toString();
}

async function fetchNextEditorUrl(url: string, init?: RequestInit): Promise<Response> {
  const urlObj = new URL(url);

  if (urlObj.origin === window.location.origin) {
    return fetch(url, init);
  }

  const proxyUrl = buildSameOriginProxyUrl(url);

  try {
    const proxyResponse = await fetch(proxyUrl, init);

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

  return fetch(url, init);
}

/**
 * Checks whether a media URL is reachable and not an HTML fallback page, without downloading
 * the body — used to verify a camera `<video src>` candidate before assigning it (playback
 * would otherwise fail silently inside the `<video>` element). Tries `HEAD` first since it's
 * cheapest; some hosts (e.g. S3 presigned URLs scoped to `GetObject`) reject `HEAD`, so a
 * ranged `GET` is the fallback.
 */
async function probeMediaUrl(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    let response = await fetchNextEditorUrl(url, { method: "HEAD", signal });
    if (!response.ok) {
      response = await fetchNextEditorUrl(url, { headers: { Range: "bytes=0-0" }, signal });
    }
    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get("content-type") ?? "";
    return !contentType.includes("text/html");
  } catch {
    return false;
  }
}

export const useUrlLoader = () => {
  const [isLoading, setIsLoading] = useState(false);
  // Surfaces a human-readable load failure to the UI instead of a blocking `alert()`,
  // so callers can render an inline, themeable error panel (with retry) in context.
  const [error, setError] = useState<string | null>(null);
  const { loadRecording, extendRecording, addCaptionTrack } = useNextEditorActions();
  const generationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

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
      const declaresExternalAudio = result.audioFile || result.audioSource === "external";
      if (declaresExternalAudio && audioFile && !(result.audioBlob instanceof Blob)) {
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

        const recordings = await decompressBinaryToRecordings(bytes);
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

  const loadRecordingFromBinaryBytes = async (
    bytes: Uint8Array,
    baseUrl?: string,
  ): Promise<Recording | null> => {
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
    const streamReader = createStreamingRecordingReader();
    let lastDecodeLength = 0;
    let loadedOnce = false;
    let latestRecording: Recording | null = null;

    const applyRecording = (recording: Recording | null | undefined) => {
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

    // Response chunks feed the incremental reader directly — a `.ne` is raw SCR3
    // bytes. A prefix that isn't decodable yet simply yields `null` (no throw); a
    // thrown error is genuine corruption/desync (or not an SCR3 stream at all) and
    // propagates to the whole-file fallback in `fetchNextEditorFile`.
    const applyStreamed = () => {
      applyRecording(streamReader.getRecording());
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
        if (downloaded - lastDecodeLength >= STREAM_DECODE_INTERVAL_BYTES) {
          lastDecodeLength = downloaded;
          applyStreamed();
        }
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
   * Finds a working audio candidate (a sibling file referenced by `audioFile` / `audioUrl`, or
   * the `.ne` basename fallback) and downloads it, without touching the recording — the caller
   * applies the result via a single `extendRecording` alongside any camera fix, so the two
   * out-of-band resolutions never race and clobber each other.
   */
  const findWorkingAudioBlob = async (
    recording: Recording,
    neUrl: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ url: string; blob: Blob } | null> => {
    if (recording.audioBlob instanceof Blob) {
      return null;
    }
    const candidates = buildMediaCandidates(
      recording.audioUrl,
      recording.audioFile,
      neUrl,
      "weba",
      recording.audioSource === "external",
    );
    for (const url of candidates) {
      try {
        const response = await fetchNextEditorUrl(url, { signal });
        if (!response.ok) {
          console.warn(`External audio fetch failed (${response.status}): ${url}`);
          continue;
        }
        const raw = await response.blob();
        if (raw.size === 0 || raw.type.includes("text/html")) {
          continue;
        }
        // Some hosts serve sibling audio without a usable content type; fall back to the
        // extension-derived MIME so `decodeAudioData` and track metadata behave.
        const type =
          (raw.type && !raw.type.includes("text/html") ? raw.type : undefined) ??
          audioMimeFromFilename(recording.audioFile ?? url) ??
          "audio/webm";
        const blob = raw.type === type ? raw : new Blob([raw], { type });
        return { url, blob };
      } catch (err) {
        console.warn(`Failed to fetch external audio from ${url}:`, err);
      }
    }
    return null;
  };

  /**
   * Finds a working camera URL — playback consumes `cameraUrl` directly via a `<video src>`,
   * which fails silently on a bad URL rather than throwing, so the happy-path guess from
   * `withResolvedMediaUrls` is verified with a cheap probe before falling back through the
   * `.ne` basename candidate. Returns `null` when the current URL already probes fine (the
   * common case) or nothing works.
   */
  const findWorkingCameraUrl = async (
    recording: Recording,
    neUrl: string | undefined,
    signal?: AbortSignal,
  ): Promise<string | null> => {
    const candidates = buildMediaCandidates(
      recording.cameraUrl,
      recording.cameraFile,
      neUrl,
      "webm",
    );
    for (const url of candidates) {
      if (await probeMediaUrl(url, signal)) {
        return url !== recording.cameraUrl ? url : null;
      }
    }
    if (candidates.length > 0) {
      console.warn("External camera video probe failed for all candidates:", candidates);
    }
    return null;
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
    if (!isNextEditorUrl(url)) {
      throw new Error("URL does not point to a supported file (.ne)");
    }

    const generation = ++generationRef.current;
    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const isStale = () => generationRef.current !== generation;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetchNextEditorUrl(url, { signal: abortController.signal });

      if (!response.ok) {
        throw new Error(`Failed to fetch file: ${response.statusText}`);
      }

      if (isStale()) return;

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

      if (isStale()) return;

      if (!loaded) {
        const source = bodyConsumed
          ? await fetchNextEditorUrl(url, { signal: abortController.signal })
          : response;
        const bytes = new Uint8Array(await source.arrayBuffer());
        loaded = await loadRecordingFromBinaryBytes(bytes, url);
      }

      if (isStale()) return;

      fetchSiblingCaptions(url, loaded?.captionFiles)
        .then((tracks) => {
          if (!isStale()) {
            for (const track of tracks) addCaptionTrack(track);
          }
        })
        .catch(() => {});

      // Externalized audio/camera resolve out-of-band, after the (now tiny) `.ne` finished.
      if (loaded && !isStale()) {
        void resolveExternalMedia(loaded, url, isStale, abortController.signal);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      if (isStale()) return;
      console.error("Failed to load tutorial from URL:", err);
      setError(`Failed to load tutorial: ${err instanceof Error ? err.message : "Unknown error"}`);
      throw err;
    } finally {
      if (!isStale()) {
        setIsLoading(false);
      }
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
