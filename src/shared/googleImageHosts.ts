// Which hosts serve Google Slides deck images. Google's slide-image CDN
// (docs.google.com/slides-images-rt/…) and its general image host
// (*.googleusercontent.com) send a Cross-Origin-Resource-Policy header that
// blocks direct cross-origin loads of these images — <img>, inline SVG
// <image>, and fetch() alike — even though the resources are publicly
// viewable, so imported slide SVGs can never reference them directly.
//
// Shared between the client-side href scan (src/googleSlides/proxyImageHrefs.ts)
// and the Worker ingest route's host allowlist
// (infra/worker/routes/slideImages.ts), following the same client/worker
// sharing pattern as src/shared/proxy.ts.

const GOOGLE_IMAGE_HOST_SUFFIX = ".googleusercontent.com";

export function isGoogleImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "docs.google.com" ||
    host === "googleusercontent.com" ||
    host.endsWith(GOOGLE_IMAGE_HOST_SUFFIX)
  );
}

/** True if `value` is an https URL on a known Google image host. */
export function isGoogleImageUrl(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  try {
    return isGoogleImageHost(new URL(value).hostname);
  } catch {
    return false;
  }
}
