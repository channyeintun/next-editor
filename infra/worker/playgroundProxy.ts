import { readBodyWithLimit } from "./httpBody";

// Plumbing shared by the language playground proxy routes (routes/{go,kotlin,
// rust,zig,haskell}Playground.ts), alongside httpBody.ts's readBodyWithLimit.
//
// Only the parts that are genuinely identical across upstreams live here: the
// fixed-window rate limiter, the content-addressed cache key, the KV result
// cache, the output bound, and the single-file request validator. Everything
// that encodes a particular service's behaviour — its request encoding, its
// non-ok status policy, its response normalization, its telemetry channel —
// stays in the route, because those are the parts that differ and the reasons
// they differ are documented there.

/**
 * Bound normalized program output. The upstreams apply their own limits well
 * below this; the marker tells the learner their output was cut rather than
 * their program stopping early.
 */
export function truncateOutput(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[output truncated]` : text;
}

/**
 * Content-addressed cache key. Callers fold their pinned compiler version and
 * flags into `prefix` so a configuration change can never serve results
 * produced under a different toolchain.
 */
export async function contentCacheKey(prefix: string, content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${hex}`;
}

// Fixed-window per-user limit in KV. Approximate by design (KV is eventually
// consistent), but fail closed when the policy store is missing or unavailable
// so a configuration outage cannot turn a route into an unlimited proxy.
export type RateLimitDecision = "allowed" | "limited" | "unavailable";

/**
 * Charge one call against `userId`'s current minute window.
 *
 * `keyPrefix` and `limit` are per route, and a route that serves both /run and
 * /format passes a different prefix for each so the two get their own budgets
 * — except where the upstream itself counts them together (zigPlayground.ts),
 * which passes one prefix for both. `label` only ever reaches console.error;
 * user sources and output must never be logged.
 */
export async function checkPlaygroundRateLimit(
  cache: KVNamespace | null,
  options: { userId: string; keyPrefix: string; limit: number; label: string },
): Promise<RateLimitDecision> {
  if (!cache) {
    return "unavailable";
  }
  const windowKey = `${options.keyPrefix}:${options.userId}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const count = Number((await cache.get(windowKey)) ?? "0");
    if (!Number.isSafeInteger(count) || count < 0) {
      console.error(`${options.label} rate-limit state was invalid`);
      return "unavailable";
    }
    if (count >= options.limit) {
      return "limited";
    }
    // Two windows' worth of TTL: the key only has to outlive the minute it
    // counts, and KV cannot expire it precisely on the boundary.
    await cache.put(windowKey, String(count + 1), { expirationTtl: 120 });
    return "allowed";
  } catch {
    console.error(`${options.label} rate-limit check failed`);
    return "unavailable";
  }
}

/**
 * Read a cached result, revalidating it through the caller's own parser: a KV
 * entry written by an older build (or a poisoned one) must never be served as
 * a result the current contract cannot describe.
 */
export async function readCachedValue<T>(
  cache: KVNamespace | null,
  key: string,
  parse: (value: unknown) => T | null,
  label: string,
): Promise<T | null> {
  if (!cache) {
    return null;
  }
  try {
    return parse(await cache.get<unknown>(key, "json"));
  } catch {
    console.error(`${label} cache read failed`);
    return null;
  }
}

export async function writeCachedValue(
  cache: KVNamespace | null,
  key: string,
  value: unknown,
  ttlSeconds: number,
  label: string,
): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    await cache.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  } catch {
    console.error(`${label} cache write failed`);
  }
}

export type SingleFileLessonRequestValidation =
  | { ok: true; code: string; sourceBytes: number }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Validate a lesson request for an upstream that compiles exactly one source
 * file under a fixed name (Rust, Zig, Haskell). The body shape is the same
 * `{ files: [{ path, content }] }` the multi-file routes accept, so a lesson
 * runner does not need to know which kind of upstream it is talking to.
 *
 * Go and Kotlin deliberately do NOT use this: they accept several files with
 * per-language path, uniqueness and import policy, which is real behaviour
 * rather than a parameter.
 */
export async function validateSingleFileLessonRequest(
  request: Request,
  options: {
    requiredPath: string;
    language: string;
    maxSourceBytes: number;
    maxRequestBytes: number;
  },
): Promise<SingleFileLessonRequestValidation> {
  const { requiredPath, language, maxSourceBytes, maxRequestBytes } = options;
  const oneFileError = `${language} lessons run exactly one ${requiredPath} file`;

  const requestBody = await readBodyWithLimit(request, maxRequestBytes);
  if (requestBody.status === "too-large") {
    return { ok: false, status: 413, error: `request body exceeds ${maxRequestBytes} bytes` };
  }
  if (requestBody.status === "read-error") {
    return { ok: false, status: 400, error: "request body could not be read" };
  }

  let body: unknown;
  try {
    body = JSON.parse(requestBody.text);
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "JSON body must be an object" };
  }

  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== "files") {
    return { ok: false, status: 400, error: "'files' is the only supported field" };
  }

  const rawFiles = (body as Record<string, unknown>).files;
  if (!Array.isArray(rawFiles) || rawFiles.length !== 1) {
    return { ok: false, status: 400, error: oneFileError };
  }

  const rawFile = rawFiles[0];
  if (typeof rawFile !== "object" || rawFile === null || Array.isArray(rawFile)) {
    return { ok: false, status: 400, error: "files[0] must be an object" };
  }

  const fileRecord = rawFile as Record<string, unknown>;
  const fileKeys = Object.keys(fileRecord);
  if (fileKeys.length !== 2 || !fileKeys.includes("path") || !fileKeys.includes("content")) {
    return {
      ok: false,
      status: 400,
      error: "files[0] must contain only 'path' and 'content'",
    };
  }
  if (fileRecord.path !== requiredPath) {
    return { ok: false, status: 400, error: oneFileError };
  }
  if (typeof fileRecord.content !== "string") {
    return { ok: false, status: 400, error: "files[0].content must be a string" };
  }

  const sourceBytes = new TextEncoder().encode(fileRecord.content).byteLength;
  if (sourceBytes > maxSourceBytes) {
    return {
      ok: false,
      status: 413,
      error: `${language} program exceeds ${maxSourceBytes} bytes`,
    };
  }

  return { ok: true, code: fileRecord.content, sourceBytes };
}
