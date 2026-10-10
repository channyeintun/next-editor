import type { CaptionTrack, Recording } from "../core/src";
import { fetchNextEditorUrl, probeMediaUrl } from "./recordingFetch";
import { createCaptionTrack } from "../captions/captionTracks";
import {
  AUDIO_MIME_BY_EXT,
  audioMimeFromFilename,
  DEFAULT_AUDIO_EXTENSION,
  DEFAULT_CAMERA_EXTENSION,
} from "../shared/recordingMediaFiles";

// The files a `.ne` loaded from a URL names beside itself (external audio, a
// camera video, caption VTTs), resolved against the `.ne` URL and fetched the
// way the URL loader (src/hooks/useUrlLoader.ts) fetches the `.ne`.

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
 * path — the loader's `resolveExternalMedia` falls back to the `.ne` basename out-of-band when
 * this guess turns out to be wrong (renamed/re-hosted media).
 */
export function withResolvedMediaUrls(
  recording: Recording,
  baseUrl: string | undefined,
): Recording {
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

async function fetchVttFile(url: string, signal?: AbortSignal): Promise<CaptionTrack | null> {
  try {
    // Same route as the `.ne` and its media: a host without CORS is reachable only via the proxy.
    const res = await fetchNextEditorUrl(url, { signal });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim().startsWith("WEBVTT")) return null;
    const { parseVtt, inferLanguageFromFilename } = await import("../captions/parseCaptions");
    const cues = parseVtt(text);
    if (cues.length === 0) return null;
    const lang = inferLanguageFromFilename(url) ?? "en";
    return createCaptionTrack({
      // Keyed on the file, not the language: ADD_CAPTION_TRACK replaces a track with the same id,
      // and two declared files can share a language (or both lack a tag and default to "en").
      id: `sibling:${new URL(url).pathname}`,
      language: lang,
      cues,
      isDefault: true,
    });
  } catch {
    return null;
  }
}

/**
 * Resolves one declared caption file against the recording's URL, returning it
 * only when it stays a sibling of that recording (null otherwise, or when it is
 * not a URL at all). Captions are companion files by definition, so this is
 * exactly the intended relationship — and it stops a recording naming an
 * absolute URL, which `new URL(file, base)` would pass through untouched, from
 * making a viewer's browser fetch an arbitrary origin. The scheme stays the
 * `.ne`'s http(s).
 */
function resolveSiblingCaptionUrl(file: string, neUrl: string): string | null {
  try {
    const base = new URL(neUrl);
    const resolved = new URL(file, base);
    if (resolved.origin !== base.origin) return null;
    const directory = base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
    if (!resolved.pathname.startsWith(directory)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Loads caption tracks the recording explicitly declares via `captionFiles`, resolved relative
 * to the `.ne` URL. Captions are never guessed from sibling filenames when a recording declares
 * none at all — HTTP has no directory listing, so a recording must name its companion VTTs to
 * have them auto-load. But when captions *are* declared and every one fails (the same rename case
 * handled for audio/camera), `<neBasename>.vtt` is tried as a last-ditch fallback candidate
 * (mirrors `buildMediaCandidates`, kept to a single candidate since captions are optional and
 * multi-language guessing would be over-engineering for this low-priority case).
 */
export async function fetchSiblingCaptions(
  neUrl: string,
  captionFiles: string[] | undefined,
  signal: AbortSignal,
): Promise<CaptionTrack[]> {
  if (!captionFiles || captionFiles.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(
    captionFiles
      .map((file) => resolveSiblingCaptionUrl(file, neUrl))
      .filter((url): url is string => url !== null)
      .map((url) => fetchVttFile(url, signal)),
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
      !captionFiles.some((file) => resolveSiblingCaptionUrl(file, neUrl) === basenameUrl)
    ) {
      const track = await fetchVttFile(basenameUrl, signal);
      if (track) tracks.push(track);
    }
  }

  return tracks;
}

/**
 * Finds a working audio candidate (a sibling file referenced by `audioFile` / `audioUrl`, or
 * the `.ne` basename fallback) and downloads it, without touching the recording — the caller
 * applies the result via a single `extendRecording` alongside any camera fix, so the two
 * out-of-band resolutions never race and clobber each other.
 */
export async function findWorkingAudioBlob(
  recording: Recording,
  neUrl: string | undefined,
  signal?: AbortSignal,
): Promise<{ url: string; blob: Blob } | null> {
  if (recording.audioBlob instanceof Blob) {
    return null;
  }
  const candidates = buildMediaCandidates(
    recording.audioUrl,
    recording.audioFile,
    neUrl,
    DEFAULT_AUDIO_EXTENSION,
    recording.audioSource === "external",
  );
  for (const url of candidates) {
    signal?.throwIfAborted();
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
        raw.type ||
        (audioMimeFromFilename(recording.audioFile ?? url) ??
          AUDIO_MIME_BY_EXT[DEFAULT_AUDIO_EXTENSION]);
      const blob = raw.type === type ? raw : new Blob([raw], { type });
      return { url, blob };
    } catch (err) {
      // An abort ends the search (the lesson was left); it says nothing about this candidate.
      if (signal?.aborted) throw err;
      console.warn(`Failed to fetch external audio from ${url}:`, err);
    }
  }
  return null;
}

/**
 * The recording's narration as a Blob: a take holds it in memory, an imported lesson may only
 * link it by `audioUrl`. Null when it has neither; a failed download throws with its status.
 * The edit panel draws its waveform from this and caption generation transcribes it.
 */
export async function loadRecordingNarration(recording: Recording): Promise<Blob | null> {
  if (recording.audioBlob instanceof Blob) return recording.audioBlob;
  if (!recording.audioUrl) return null;
  const response = await fetch(recording.audioUrl);
  if (!response.ok) throw new Error(`The narration could not be loaded (${response.status}).`);
  return response.blob();
}

/**
 * Finds a working camera URL — playback consumes `cameraUrl` directly via a `<video src>`,
 * which fails silently on a bad URL rather than throwing, so the happy-path guess from
 * `withResolvedMediaUrls` is verified with a cheap probe before falling back through the
 * `.ne` basename candidate. Returns `null` when the current URL already probes fine (the
 * common case) or nothing works.
 */
export async function findWorkingCameraUrl(
  recording: Recording,
  neUrl: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  const candidates = buildMediaCandidates(
    recording.cameraUrl,
    recording.cameraFile,
    neUrl,
    DEFAULT_CAMERA_EXTENSION,
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
}
