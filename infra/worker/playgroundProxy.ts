import type { Context } from "hono";
import { sha256Hex } from "../../src/shared/sha256Hex";
import { getCurrentUser } from "./auth/session";
import type { Env } from "./env";
import { isJsonObject, readJsonWithLimit } from "./httpBody";
import type { WaitUntil } from "./waitUntil";

// Plumbing shared by the language playground proxy routes (routes/{go,kotlin,
// rust,zig,haskell}Playground.ts), alongside httpBody.ts's readBodyWithLimit.
//
// Only the parts that are genuinely identical across upstreams live here: the
// rate-limit key and check, the content-addressed cache key, the KV result
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

// Per-caller limit through a Workers Rate Limiting binding. Approximate by
// design (Cloudflare counts per location), but fail closed when the binding is
// missing or unavailable so a configuration outage cannot turn a route into an
// unlimited proxy.
export type RateLimitDecision = "allowed" | "limited" | "unavailable";

/** The key every signed-out caller without a CF-Connecting-IP header shares. */
const UNKNOWN_CLIENT_KEY = "ip:unknown";

/**
 * The first 64 bits of an IPv6 address, written as a /64 prefix, or null when
 * `address` is not an IPv6 address this can read.
 */
function ipv6Slash64(address: string): string | null {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) {
    return null;
  }
  const groupsOf = (half: string | undefined) => (half ? half.split(":") : []);
  // A dotted IPv4 ending ("::ffff:192.0.2.1") fills the last two groups.
  const widthOf = (groups: string[]) =>
    groups.reduce((width, group) => width + (group.includes(".") ? 2 : 1), 0);
  const head = groupsOf(halves[0]);
  const tail = groupsOf(halves[1]);
  // How many zero groups "::" stands for; without "::" there must be none.
  const missing = 8 - widthOf(head) - widthOf(tail);
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return null;
  }
  const prefix = [...head, ...Array<string>(missing).fill("0"), ...tail].slice(0, 4);
  if (!prefix.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return `${prefix.map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}

/**
 * The key a playground call is charged to on its route's rate limiter.
 *
 * A signed-in learner is charged as "user:<id>". A signed-out learner is
 * charged by the client address Cloudflare puts in CF-Connecting-IP, as
 * "ip:<address>". An IPv6 address is cut to its /64, because one IPv6 client
 * usually holds a whole /64 and could otherwise take a fresh budget for every
 * address in it. Without the header (local dev, tests) every signed-out
 * caller shares the one "ip:unknown" key, so a missing header can only make the
 * limit stricter, never lift it.
 *
 * The address is only ever this key: it is never logged, never sent upstream,
 * and never stored by this Worker.
 */
export async function playgroundRateLimitKey<E extends { Bindings: Env }>(
  c: Context<E>,
): Promise<string> {
  const user = await getCurrentUser(c);
  if (user) {
    return `user:${user.id}`;
  }
  const address = c.req.header("CF-Connecting-IP")?.trim();
  if (!address) {
    return UNKNOWN_CLIENT_KEY;
  }
  if (!address.includes(":")) {
    return `ip:${address}`;
  }
  const prefix = ipv6Slash64(address);
  return prefix ? `ip:${prefix}` : UNKNOWN_CLIENT_KEY;
}

/**
 * Charge one call against `key`'s budget on `limiter`. The key comes from
 * playgroundRateLimitKey, so every route charges callers the same way.
 *
 * Each budget is its own binding, declared with its limit and period in
 * infra/wrangler.toml. A route that serves both /run and /format passes a
 * different binding for each so the two get their own budgets — except where
 * the upstream itself counts them together (zigPlayground.ts), which passes
 * one binding for both. `label` only ever reaches console.error; user sources,
 * output and the key itself must never be logged.
 */
export async function checkPlaygroundRateLimit(
  limiter: RateLimit | undefined,
  options: { key: string; label: string },
): Promise<RateLimitDecision> {
  if (!limiter) {
    return "unavailable";
  }
  try {
    const { success } = await limiter.limit({ key: options.key });
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

/**
 * Store a result for later runs of the same program. With the request's
 * `waitUntil` (requestWaitUntil in waitUntil.ts) the result goes back to the
 * learner without waiting for the write, which goes to KV's central store
 * (330-430 ms measured from Singapore). Nothing reads the entry before a later
 * run, and a write the runtime drops only costs that run a miss.
 */
export async function writeCachedValue(
  cache: KVNamespace | null,
  key: string,
  value: unknown,
  ttlSeconds: number,
  label: string,
  waitUntil?: WaitUntil,
): Promise<void> {
  if (!cache) {
    return;
  }
  const write = (async () => {
    try {
      await cache.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
    } catch {
      console.error(`${label} cache write failed`);
    }
  })();
  if (waitUntil) {
    waitUntil(write);
  } else {
    await write;
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
  const requestBody = await readJsonWithLimit(request, maxRequestBytes);
  if (requestBody.status === "too-large") {
    return { ok: false, status: 413, error: `request body exceeds ${maxRequestBytes} bytes` };
  }
  if (requestBody.status === "read-error") {
    return { ok: false, status: 400, error: "request body could not be read" };
  }
  if (requestBody.status === "invalid-json") {
    return { ok: false, status: 400, error: "invalid JSON body" };
  }

  const body = requestBody.value;
  if (!isJsonObject(body)) {
    return { ok: false, status: 400, error: "JSON body must be an object" };
  }

  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== "files") {
    return { ok: false, status: 400, error: "'files' is the only supported field" };
  }

  return { ok: true, rawFiles: body.files };
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
