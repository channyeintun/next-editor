// Lesson assets are served same-origin from the host app's public/ folder.
export function resolveThumb(path: string): string {
  return `/${path}`;
}

/**
 * A lesson page. Opened from a playlist, `?list=` carries the playlist along,
 * so the page can show its lessons and Continue to Next can follow its order.
 */
export function lessonHref(lessonSlug: string, listSlug?: string): string {
  return listSlug ? `/learn/${lessonSlug}?list=${listSlug}` : `/learn/${lessonSlug}`;
}

/** A playlist's public page. */
export function playlistHref(playlistSlug: string): string {
  return `/learn/playlist/${playlistSlug}`;
}
