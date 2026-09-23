/**
 * The absolute http(s) URL of a requested recording, or null. `url` arrives already
 * percent-decoded (URLSearchParams.get decodes the param), so it is used as is;
 * decoding it again would turn an escaped `%23` into a fragment or `%2B` into a
 * space. A relative path is relative to the site root.
 */
export function resolveRecordingUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    const resolved = new URL(url, `${window.location.origin}/`);
    return resolved.protocol === "http:" || resolved.protocol === "https:"
      ? resolved.toString()
      : null;
  } catch {
    return null;
  }
}
