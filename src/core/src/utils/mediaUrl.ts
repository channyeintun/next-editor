/**
 * Scheme guard for the media URLs a recording carries into element `src`
 * attributes: the audio player's `audio.src` (audioActor) and the camera
 * overlay's `<video src>` (CameraOverlay).
 *
 * `audioUrl` and `cameraUrl` come out of the `.ne` header, which is decoded with
 * a bare type assertion — no runtime validation — and a recording can be handed
 * to a viewer through `?url=`, a drag-and-drop, or the public lesson library.
 * This keeps non-network schemes (`javascript:`, `data:`, `file:`, …) out of
 * those attributes. It does not restrict the host: any `http:`/`https:` URL
 * passes. `blob:` stays allowed because the same fields carry locally-created
 * object URLs during live recording and playback of an in-memory session.
 * Caption files follow a stricter rule, same origin and directory as the `.ne`
 * (`resolveSiblingCaptionUrl` in src/hooks/useUrlLoader.ts).
 */
const ALLOWED_MEDIA_PROTOCOLS = new Set(["http:", "https:", "blob:"]);

export function isAllowedRecordingMediaUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    // Resolved against the document when relative, matching how the browser
    // would interpret it in a `src` attribute.
    const base = typeof location === "undefined" ? undefined : location.href;
    return ALLOWED_MEDIA_PROTOCOLS.has(new URL(value, base).protocol);
  } catch {
    return false;
  }
}

/** The URL when it is safe to use as a media source, otherwise null. */
export function allowedRecordingMediaUrl(value: string | null | undefined): string | null {
  return isAllowedRecordingMediaUrl(value) ? value : null;
}
