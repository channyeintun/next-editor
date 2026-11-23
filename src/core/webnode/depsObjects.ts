// The prepared objects an install reads in place of the registry: a plan or a
// package's tar, each named by the SHA-256 of the bytes it decodes to. The
// runtime host serves them, the bucket keeps them, and the installer asks for
// them, all by the names below.

/** The path every object is served under on the runtime host. */
export const DEPS_OBJECT_PATH_PREFIX = "/__webnode__/deps/";

// 64 lowercase hex digits: one spelling per id, so one object has one URL and one cache entry.
const OBJECT_ID = /^[0-9a-f]{64}$/;

/** Whether `id` is an object id: exactly 64 lowercase hex digits. */
export function isDepsObjectId(id: string): boolean {
  return OBJECT_ID.test(id);
}

/** The path the runtime host serves object `id` at. */
export function depsObjectPath(id: string): string {
  return `${DEPS_OBJECT_PATH_PREFIX}${id}`;
}

/** The object id `pathname` names, or null unless it is exactly the prefix plus an id. */
export function depsObjectIdOfPath(pathname: string): string | null {
  if (!pathname.startsWith(DEPS_OBJECT_PATH_PREFIX)) {
    return null;
  }
  const id = pathname.slice(DEPS_OBJECT_PATH_PREFIX.length);
  return isDepsObjectId(id) ? id : null;
}

/**
 * The key of object `id` in the bucket. The installer checks every object
 * against its id, and the ids come from the runtime's own bundle (the plan
 * index, then the plans it names), so this prefix is trusted no further than
 * a deploy: whoever writes it cannot plant code without changing the bundle.
 * The media route must never serve this prefix.
 */
export function depsObjectKey(id: string): string {
  return `webnode-deps/${id}`;
}

/**
 * The headers of an object served: stored Brotli-compressed so `fetch` hands
 * the process the decoded bytes, and kept for good since an id never names
 * other bytes. `no-transform` stops a proxy from re-encoding what the id checks.
 */
export const DEPS_OBJECT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/octet-stream",
  "content-encoding": "br",
  "cache-control": "public, max-age=31536000, immutable, no-transform",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
  vary: "Accept-Encoding",
});

/** The headers of every refusal under the prefix: an object missing now may be uploaded later. */
export const DEPS_OBJECT_REFUSAL_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "no-store",
});
