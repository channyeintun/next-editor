/**
 * Scheme guard for media URLs that arrive inside a recording.
 *
 * `audioUrl`, `cameraUrl` and `captionFiles` come out of the `.ne` header,
 * which is decoded with a bare type assertion — no runtime validation — and a
 * recording can be handed to a viewer through `?url=`, a drag-and-drop, or the
 * public lesson library. Those values are then assigned straight to
 * `audio.src`, a `<video src>`, and `fetch()`.
 *
 * Restricting them to real network schemes keeps a hostile recording from
 * turning a viewer's browser into a request source for an arbitrary target, and
 * keeps non-network schemes out of element `src` attributes entirely. `blob:`
 * stays allowed because the same fields carry locally-created object URLs
 * during live recording and playback of an in-memory session.
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
