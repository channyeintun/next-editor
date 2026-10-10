// Byte limits on the files a lesson upload carries. The Worker's upload route
// (infra/worker/routes/uploads.ts) enforces them and the upload client checks
// them first, so an upload that cannot succeed says why before any bytes go
// over the wire.

/**
 * Cloudflare caps a request body at 100 MB and rejects past it *at the edge*,
 * before the Worker route runs — so an oversized PUT comes back as a bare 413
 * with no JSON body explaining which file lost. The route and the client share
 * this number so the limit is enforced somewhere that can say what went wrong,
 * and so an upload that cannot succeed fails before the bytes go over the wire
 * instead of after minutes of progress bar.
 *
 * This is the platform's ceiling, not a product decision: raising it means
 * moving to a Cloudflare plan with a larger body limit (Business is 200 MB),
 * not editing this constant.
 */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export function formatMediaBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Keeps the upload PUT snappy and R2 tidy — generous for a thumbnail image.
export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

// Hard backstop for a text subtitle file — hours of captions fit well under this.
export const MAX_CAPTION_BYTES = 2 * 1024 * 1024;
