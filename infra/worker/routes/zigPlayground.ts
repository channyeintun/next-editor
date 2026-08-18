import { Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser } from "../auth/session";
import { getCache } from "../cache";
import { readBodyWithLimit } from "../httpBody";
import {
  parseZigPlaygroundRunResult,
  type ZigPlaygroundFormatResult,
  type ZigPlaygroundRunResult,
} from "../../../src/runtime/zigPlayground/types";

// Mounted at /api/zig-playground in worker/index.ts. First-party proxy in
// front of the community Zig Playground run and fmt APIs (zig-play.dev) for
// pure Zig lessons, mirroring the Go, Kotlin, and Rust routes. The browser
// never calls the upstream service directly: this route owns the kill switch,
// authentication, program-size checks, per-user rate limiting, content-hash
// caching, the unique user agent, the upstream timeout, and normalization of
// the upstream response into the app's ZigPlaygroundRunResult contract.
//
// Two upstream properties shape everything below:
//
//  1. The protocol is plain text, not JSON. The request body IS the source
//     file and the response body IS the output — there are no fields to read,
//     so the status classification has to be inferred from the text.
//  2. HTTP 400 is overloaded. `zig run` exits non-zero both when the program
//     fails to COMPILE and when it compiles and then PANICS, and the upstream
//     reports both as 400. Those are completely different things to a learner,
//     so classifyFailure below separates them by looking for the stack-trace
//     addresses that only a running program can produce.
//
// The upstream also rate-limits at 5 requests per minute per client IP. Our
// per-user limit is set below that and deterministic outcomes are cached, so
// one lesson's repeated runs do not spend the shared budget.
//
// Privacy invariant: user sources, program output, and diagnostics must never
// be logged — telemetry is aggregate fields only (see logRun below). Nothing
// application-specific (cookies, tokens, user identity) is sent upstream.

const UPSTREAM_RUN_URL = "https://zig-play.dev/server/run";
const UPSTREAM_FORMAT_URL = "https://zig-play.dev/server/fmt";
// The compiler version is pinned and folded into the cache-key prefix so a
// version change can never serve results produced by a different compiler.
// The upstream also offers "0.15.2" and "master"; master is deliberately not
// used, because a lesson's recorded output must stay reproducible.
const UPSTREAM_ZIG_VERSION = "0.16.0";
// Identifies Next Editor traffic to the upstream service, matching the other
// playground routes' third-party client etiquette.
const UPSTREAM_USER_AGENT = "NextEditor-ZigPlayground/1.0 (+https://nexteditor.dev)";
// Zig compiles fast, but a cold cache on the upstream plus a slow program can
// still take a while; keep the same 20s bound the other playground routes use.
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_SOURCE_BYTES = 64 * 1024;
// JSON escaping can expand one source byte to six bytes. Leave bounded room
// for the file path and object syntax while allowing every valid program.
const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES * 6 + 4096;
// Defensive bound on normalized program output; the Playground applies its
// own output limits well below this.
const MAX_OUTPUT_CHARS = 256 * 1024;
// The upstream answers in text/plain, so its body needs no JSON headroom —
// but a runaway program's output still has to be bounded before it is read.
const MAX_UPSTREAM_RESPONSE_BYTES = MAX_OUTPUT_CHARS + 64 * 1024;
const MAX_EXIT_DETAIL_CHARS = 256;
const CACHE_TTL_SECONDS = 60 * 60;
// Deliberately below the upstream's own 5/minute per-IP budget: every Next
// Editor user shares this Worker's egress, so our ceiling has to leave room
// for other users rather than spend the whole upstream window on one person.
const RATE_LIMIT_RUNS_PER_MINUTE = 4;
const RATE_LIMIT_FORMATS_PER_MINUTE = 8;

// The upstream compiles one root source file from a single text body, so
// lessons submit exactly one file with this fixed name.
const REQUIRED_FILE_PATH = "main.zig";

type ZigLessonRequestValidation =
  | {
      ok: true;
      code: string;
      sourceBytes: number;
    }
  | { ok: false; status: 400 | 413; error: string };

async function validateZigLessonRequest(request: Request): Promise<ZigLessonRequestValidation> {
  const requestBody = await readBodyWithLimit(request, MAX_REQUEST_BYTES);
  if (requestBody.status === "too-large") {
    return { ok: false, status: 413, error: `request body exceeds ${MAX_REQUEST_BYTES} bytes` };
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
    return {
      ok: false,
      status: 400,
      error: "Zig lessons run exactly one main.zig file",
    };
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
  if (fileRecord.path !== REQUIRED_FILE_PATH) {
    return { ok: false, status: 400, error: "Zig lessons run exactly one main.zig file" };
  }
  if (typeof fileRecord.content !== "string") {
    return { ok: false, status: 400, error: "files[0].content must be a string" };
  }

  const sourceBytes = new TextEncoder().encode(fileRecord.content).byteLength;
  if (sourceBytes > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Zig program exceeds ${MAX_SOURCE_BYTES} bytes`,
    };
  }

  return { ok: true, code: fileRecord.content, sourceBytes };
}

// The sandbox compiles the submitted source at a scratch path and resolves
// the standard library out of a version-pinned toolchain directory. Both leak
// into every diagnostic and every stack trace. Rewriting them to the names the
// learner actually sees keeps server layout out of the lesson console and
// keeps recorded output stable across upstream redeploys, whose scratch
// directory number changes on every single run.
const UPSTREAM_SOURCE_PATH = /\/tmp\/playground\d+\/play\.zig/g;
const UPSTREAM_STDLIB_PATH = /\/home\/play\/\.zvm\/[^/]+\/lib\/std\//g;
const UPSTREAM_MODULE_NAME = /\(play\.zig\)/g;

export function scrubUpstreamPaths(text: string): string {
  return text
    .replace(UPSTREAM_SOURCE_PATH, REQUIRED_FILE_PATH)
    .replace(UPSTREAM_STDLIB_PATH, "std/")
    .replace(UPSTREAM_MODULE_NAME, `(${REQUIRED_FILE_PATH})`);
}

function truncateOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`
    : text;
}

// A stack trace frame carries a resolved code address ("main.zig:5:23:
// 0x11d2d2c in main"). Only a process that actually started can produce one,
// so its presence is the reliable signal that the program compiled and then
// failed at runtime. Compiler diagnostics point at source locations and never
// carry an address, including in their "referenced by:" trace.
const RUNTIME_STACK_FRAME = /:\s0x[0-9a-f]+\sin\s/;
// Emitted by the panic handler, e.g. "thread 10 panic: integer overflow".
const PANIC_HEADER = /^thread \d+ panic: (.+)$/m;
// An error returned all the way out of main is reported as a bare
// "error: Name" line at column zero, then a trace. Compiler diagnostics also
// contain "error:", but always prefixed by a source location, so anchoring to
// the start of the line separates them.
const UNHANDLED_ERROR_HEADER = /^error: ([A-Za-z_][A-Za-z0-9_]*)$/m;

/**
 * Split an upstream failure body into "the program never built" and "the
 * program built, ran, and then died". The upstream reports both as HTTP 400.
 */
export function classifyFailure(body: string): {
  status: "compile-error" | "runtime-error";
  exitDetail?: string;
} {
  const panic = PANIC_HEADER.exec(body);
  if (panic) {
    return { status: "runtime-error", exitDetail: `panic: ${panic[1].trim()}` };
  }

  const unhandled = UNHANDLED_ERROR_HEADER.exec(body);
  if (unhandled) {
    return { status: "runtime-error", exitDetail: `unhandled error: ${unhandled[1]}` };
  }

  if (RUNTIME_STACK_FRAME.test(body)) {
    return { status: "runtime-error", exitDetail: "Program exited with an error" };
  }

  return { status: "compile-error" };
}

/**
 * Normalize the upstream run response. The upstream speaks text/plain, so the
 * HTTP status plus the body text is the entire signal:
 *   200 -> the program compiled, ran, and exited zero
 *   400 -> it failed to compile, OR it ran and then panicked
 * Any other status is not a program outcome and returns null, which the
 * caller turns into a 502 rather than a successful empty run.
 */
export function normalizeUpstreamRunResponse(
  httpStatus: number,
  body: string,
): ZigPlaygroundRunResult | null {
  const scrubbed = scrubUpstreamPaths(body);

  if (httpStatus === 200) {
    return { status: "success", output: truncateOutput(scrubbed) };
  }

  if (httpStatus !== 400) {
    return null;
  }

  // A 400 with nothing in it describes no outcome at all.
  if (!scrubbed.trim()) {
    return null;
  }

  const classified = classifyFailure(scrubbed);
  if (classified.status === "compile-error") {
    return {
      status: "compile-error",
      output: "",
      compileErrors: truncateOutput(scrubbed),
    };
  }

  return {
    status: "runtime-error",
    output: truncateOutput(scrubbed),
    exitDetail:
      (classified.exitDetail ?? "").slice(0, MAX_EXIT_DETAIL_CHARS) ||
      "Program exited with an error",
  };
}

/**
 * Normalize the upstream fmt response. Success returns the formatted source;
 * a source error returns the parse diagnostics, which belong to the user's
 * program rather than to the service.
 */
export function normalizeUpstreamFormatResponse(
  httpStatus: number,
  body: string,
):
  | { kind: "result"; result: ZigPlaygroundFormatResult }
  | { kind: "source-error"; error: string }
  | null {
  if (httpStatus === 400) {
    const scrubbed = scrubUpstreamPaths(body).replace(/^<stdin>/gm, REQUIRED_FILE_PATH);
    return scrubbed.trim() ? { kind: "source-error", error: scrubbed } : null;
  }

  if (httpStatus !== 200) {
    return null;
  }

  if (new TextEncoder().encode(body).byteLength > MAX_SOURCE_BYTES) {
    return null;
  }

  return {
    kind: "result",
    result: { files: [{ path: REQUIRED_FILE_PATH, content: body }] },
  };
}

// Content-addressed cache key. The pinned compiler version is folded into the
// prefix so a version change can never serve results produced by a different
// compiler.
async function cacheKeyForSource(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `zp:${UPSTREAM_ZIG_VERSION}:${hex}`;
}

// Fixed-window per-user limit in KV. Approximate by design (KV is eventually
// consistent), but fail closed when the policy store is missing or unavailable
// so a configuration outage cannot turn this route into an unlimited proxy.
type RateLimitDecision = "allowed" | "limited" | "unavailable";

async function checkRateLimit(
  cache: KVNamespace | null,
  userId: string,
  keyPrefix: "zp:rl" | "zp:fmt:rl",
  limit: number,
): Promise<RateLimitDecision> {
  if (!cache) {
    return "unavailable";
  }
  const windowKey = `${keyPrefix}:${userId}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const count = Number((await cache.get(windowKey)) ?? "0");
    if (!Number.isSafeInteger(count) || count < 0) {
      console.error("Zig Playground rate-limit state was invalid");
      return "unavailable";
    }
    if (count >= limit) {
      return "limited";
    }
    await cache.put(windowKey, String(count + 1), { expirationTtl: 120 });
    return "allowed";
  } catch {
    console.error("Zig Playground rate-limit check failed");
    return "unavailable";
  }
}

async function readCachedResult(
  cache: KVNamespace | null,
  key: string,
): Promise<ZigPlaygroundRunResult | null> {
  if (!cache) {
    return null;
  }
  try {
    return parseZigPlaygroundRunResult(await cache.get<unknown>(key, "json"));
  } catch {
    console.error("Zig Playground cache read failed");
    return null;
  }
}

async function writeCachedResult(
  cache: KVNamespace | null,
  key: string,
  result: ZigPlaygroundRunResult,
): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    await cache.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    console.error("Zig Playground cache write failed");
  }
}

// Aggregate telemetry only — never sources, output, or diagnostics text.
function logRun(entry: {
  outcome:
    | ZigPlaygroundRunResult["status"]
    | "upstream-error"
    | "upstream-timeout"
    | "upstream-rate-limited";
  sourceBytes: number;
  cacheHit: boolean;
  durationMs: number;
}): void {
  console.log("zig-playground-run", entry);
}

function logFormat(entry: {
  outcome:
    | "success"
    | "source-error"
    | "upstream-error"
    | "upstream-timeout"
    | "upstream-rate-limited";
  sourceBytes: number;
  durationMs: number;
}): void {
  console.log("zig-playground-format", entry);
}

async function fetchUpstream(url: string, code: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "X-Zig-Version": UPSTREAM_ZIG_VERSION,
      "User-Agent": UPSTREAM_USER_AGENT,
    },
    body: code,
    signal,
  });
}

export const zigPlaygroundRoute = new Hono<{ Bindings: Env }>();

zigPlaygroundRoute.post("/run", async (c) => {
  // Shared Zig-tool kill switch fails closed unless explicitly enabled.
  // Editing and recorded playback never touch either live route.
  if (c.env.ZIG_PLAYGROUND_ENABLED !== "true") {
    return c.json({ error: "Zig Playground execution is disabled" }, 503);
  }

  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const request = await validateZigLessonRequest(c.req.raw);
  if (!request.ok) {
    return request.status === 413
      ? c.json({ error: request.error }, 413)
      : c.json({ error: request.error }, 400);
  }
  const { code, sourceBytes } = request;

  const cache = getCache(c.env);
  const rateLimitDecision = await checkRateLimit(
    cache,
    user.id,
    "zp:rl",
    RATE_LIMIT_RUNS_PER_MINUTE,
  );
  if (rateLimitDecision === "limited") {
    return c.json({ error: "rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Zig Playground execution policy is unavailable" }, 502);
  }

  const startedAt = Date.now();
  const cacheKey = await cacheKeyForSource(code);
  const cachedResult = await readCachedResult(cache, cacheKey);
  if (cachedResult) {
    logRun({
      outcome: cachedResult.status,
      sourceBytes,
      cacheHit: true,
      durationMs: Date.now() - startedAt,
    });
    return c.json(cachedResult);
  }

  const upstreamSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchUpstream(UPSTREAM_RUN_URL, code, upstreamSignal);
  } catch (error) {
    const timedOut =
      upstreamSignal.aborted || (error instanceof Error && error.name === "TimeoutError");
    logRun({
      outcome: timedOut ? "upstream-timeout" : "upstream-error",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return timedOut
      ? c.json({ error: "the program took too long to compile and run" }, 504)
      : c.json({ error: "the Zig Playground service is unavailable" }, 502);
  }

  // The upstream's own per-IP budget is shared by every Next Editor user, so
  // surface its 429 as ours instead of as a generic failure.
  if (upstreamResponse.status === 429) {
    logRun({
      outcome: "upstream-rate-limited",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Zig Playground is busy; retry in a minute" }, 429);
  }

  const upstreamBody = await readBodyWithLimit(upstreamResponse, MAX_UPSTREAM_RESPONSE_BYTES);
  if (upstreamBody.status === "read-error" && upstreamSignal.aborted) {
    logRun({
      outcome: "upstream-timeout",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the program took too long to compile and run" }, 504);
  }

  const result =
    upstreamBody.status === "ok"
      ? normalizeUpstreamRunResponse(upstreamResponse.status, upstreamBody.text)
      : null;

  if (!result) {
    logRun({
      outcome: "upstream-error",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Zig Playground service returned an unexpected response" }, 502);
  }

  // Only deterministic outcomes are cached, mirroring the other playground
  // routes: success and compile-error re-serve; runtime errors always re-run.
  if (result.status === "success" || result.status === "compile-error") {
    await writeCachedResult(cache, cacheKey, result);
  }

  logRun({
    outcome: result.status,
    sourceBytes,
    cacheHit: false,
    durationMs: Date.now() - startedAt,
  });
  return c.json(result);
});

zigPlaygroundRoute.post("/format", async (c) => {
  if (c.env.ZIG_PLAYGROUND_ENABLED !== "true") {
    return c.json({ error: "Zig Playground tools are disabled" }, 503);
  }

  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const request = await validateZigLessonRequest(c.req.raw);
  if (!request.ok) {
    return request.status === 413
      ? c.json({ error: request.error }, 413)
      : c.json({ error: request.error }, 400);
  }

  const cache = getCache(c.env);
  const rateLimitDecision = await checkRateLimit(
    cache,
    user.id,
    "zp:fmt:rl",
    RATE_LIMIT_FORMATS_PER_MINUTE,
  );
  if (rateLimitDecision === "limited") {
    return c.json({ error: "format rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Zig Playground formatting policy is unavailable" }, 502);
  }

  const startedAt = Date.now();
  const upstreamSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchUpstream(UPSTREAM_FORMAT_URL, request.code, upstreamSignal);
  } catch (error) {
    const timedOut =
      upstreamSignal.aborted || (error instanceof Error && error.name === "TimeoutError");
    logFormat({
      outcome: timedOut ? "upstream-timeout" : "upstream-error",
      sourceBytes: request.sourceBytes,
      durationMs: Date.now() - startedAt,
    });
    return timedOut
      ? c.json({ error: "formatting took too long" }, 504)
      : c.json({ error: "the Zig Playground formatter is unavailable" }, 502);
  }

  if (upstreamResponse.status === 429) {
    logFormat({
      outcome: "upstream-rate-limited",
      sourceBytes: request.sourceBytes,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Zig Playground is busy; retry in a minute" }, 429);
  }

  const upstreamBody = await readBodyWithLimit(upstreamResponse, MAX_UPSTREAM_RESPONSE_BYTES);
  if (upstreamBody.status === "read-error" && upstreamSignal.aborted) {
    logFormat({
      outcome: "upstream-timeout",
      sourceBytes: request.sourceBytes,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "formatting took too long" }, 504);
  }

  const normalized =
    upstreamBody.status === "ok"
      ? normalizeUpstreamFormatResponse(upstreamResponse.status, upstreamBody.text)
      : null;

  if (!normalized) {
    logFormat({
      outcome: "upstream-error",
      sourceBytes: request.sourceBytes,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Zig Playground formatter returned an unexpected response" }, 502);
  }

  if (normalized.kind === "source-error") {
    logFormat({
      outcome: "source-error",
      sourceBytes: request.sourceBytes,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: normalized.error }, 422);
  }

  logFormat({
    outcome: "success",
    sourceBytes: request.sourceBytes,
    durationMs: Date.now() - startedAt,
  });
  return c.json(normalized.result);
});
