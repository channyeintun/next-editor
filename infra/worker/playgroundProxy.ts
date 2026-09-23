import { sha256Hex } from "../../src/shared/sha256Hex";
import { readBodyWithLimit } from "./httpBody";

// Plumbing shared by the language playground proxy routes (routes/{go,kotlin,
// rust,zig,haskell}Playground.ts), alongside httpBody.ts's readBodyWithLimit.
//
// Only the parts that are genuinely identical across upstreams live here: the
// per-user rate-limit check, the content-addressed cache key, the KV result
// cache, the output bound, and reading the `{ files: [...] }` request body
// (whole for single-file upstreams, up to the per-language policy for Go and
// Kotlin). Everything that encodes a particular service's behaviour — its file
// path and source policy, its request encoding, its non-ok status policy, its
// response normalization, its telemetry channel — stays in the route, because
// those are the parts that differ and the reasons they differ are documented
// there.

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
  return `${prefix}:${await sha256Hex(content)}`;
}

// Per-user limit through a Workers Rate Limiting binding. Approximate by design
// (Cloudflare counts per location), but fail closed when the binding is missing
// or unavailable so a configuration outage cannot turn a route into an
// unlimited proxy.
export type RateLimitDecision = "allowed" | "limited" | "unavailable";

/**
 * Charge one call against `userId`'s budget on `limiter`.
 *
 * Each budget is its own binding, declared with its limit and period in
 * infra/wrangler.toml. A route that serves both /run and /format passes a
 * different binding for each so the two get their own budgets — except where
 * the upstream itself counts them together (zigPlayground.ts), which passes
 * one binding for both. `label` only ever reaches console.error; user sources
 * and output must never be logged.
 */
export async function checkPlaygroundRateLimit(
  limiter: RateLimit | undefined,
  options: { userId: string; label: string },
): Promise<RateLimitDecision> {
  if (!limiter) {
    return "unavailable";
  }
  try {
    const { success } = await limiter.limit({ key: options.userId });
    return success ? "allowed" : "limited";
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

/** A lesson request refused before it reaches the upstream. */
export type LessonRequestRejection = { ok: false; status: 400 | 413; error: string };

/** One `{ path, content }` entry of a lesson request, both strings. */
export interface LessonFile {
  path: string;
  content: string;
}

/**
 * Read a lesson request's `{ files: [...] }` body as far as its `files` value:
 * the byte ceiling, JSON, and `files` as the only field. Every playground route
 * starts here, so a malformed request gets the same answer from each of them.
 */
async function readLessonFilesField(
  request: Request,
  maxRequestBytes: number,
): Promise<{ ok: true; rawFiles: unknown } | LessonRequestRejection> {
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

  return { ok: true, rawFiles: (body as Record<string, unknown>).files };
}

/** `files[index]` as a record holding exactly `path` and `content`, or why it is not one. */
function lessonFileRecord(
  rawFile: unknown,
  index: number,
): { ok: true; record: Record<string, unknown> } | LessonRequestRejection {
  if (typeof rawFile !== "object" || rawFile === null || Array.isArray(rawFile)) {
    return { ok: false, status: 400, error: `files[${index}] must be an object` };
  }
  const record = rawFile as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("path") || !keys.includes("content")) {
    return {
      ok: false,
      status: 400,
      error: `files[${index}] must contain only 'path' and 'content'`,
    };
  }
  return { ok: true, record };
}

/**
 * Read a request for an upstream that compiles several files (Go, Kotlin):
 * 1 to `maxFiles` `{ path, content }` string pairs, naming the first malformed
 * entry. Path, uniqueness and source policy are the route's own, applied to
 * the files this returns.
 */
export async function readMultiFileLessonRequest(
  request: Request,
  options: { language: string; maxFiles: number; maxRequestBytes: number },
): Promise<{ ok: true; files: LessonFile[] } | LessonRequestRejection> {
  const { language, maxFiles, maxRequestBytes } = options;
  const field = await readLessonFilesField(request, maxRequestBytes);
  if (!field.ok) return field;

  const { rawFiles } = field;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `'files' must contain at least one ${language} source file`,
    };
  }
  if (rawFiles.length > maxFiles) {
    return {
      ok: false,
      status: 400,
      error: `${language} lessons support at most ${maxFiles} files`,
    };
  }

  const files: LessonFile[] = [];
  for (const [index, rawFile] of rawFiles.entries()) {
    const entry = lessonFileRecord(rawFile, index);
    if (!entry.ok) return entry;
    const { path, content } = entry.record;
    if (typeof path !== "string") {
      return { ok: false, status: 400, error: `files[${index}].path must be a string` };
    }
    if (typeof content !== "string") {
      return { ok: false, status: 400, error: `files[${index}].content must be a string` };
    }
    files.push({ path, content });
  }
  return { ok: true, files };
}

export type SingleFileLessonRequestValidation =
  | { ok: true; code: string; sourceBytes: number }
  | LessonRequestRejection;

/**
 * Validate a lesson request for an upstream that compiles exactly one source
 * file under a fixed name (Rust, Zig, Haskell). The body shape is the same
 * `{ files: [{ path, content }] }` the multi-file routes accept (see
 * readMultiFileLessonRequest), so a lesson runner does not need to know which
 * kind of upstream it is talking to.
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

  const field = await readLessonFilesField(request, maxRequestBytes);
  if (!field.ok) return field;

  const { rawFiles } = field;
  if (!Array.isArray(rawFiles) || rawFiles.length !== 1) {
    return { ok: false, status: 400, error: oneFileError };
  }

  const entry = lessonFileRecord(rawFiles[0], 0);
  if (!entry.ok) return entry;
  const { path, content } = entry.record;
  if (path !== requiredPath) {
    return { ok: false, status: 400, error: oneFileError };
  }
  if (typeof content !== "string") {
    return { ok: false, status: 400, error: "files[0].content must be a string" };
  }

  const sourceBytes = new TextEncoder().encode(content).byteLength;
  if (sourceBytes > maxSourceBytes) {
    return {
      ok: false,
      status: 413,
      error: `${language} program exceeds ${maxSourceBytes} bytes`,
    };
  }

  return { ok: true, code: content, sourceBytes };
}
