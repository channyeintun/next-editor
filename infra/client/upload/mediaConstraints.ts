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
