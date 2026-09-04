import { Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser } from "../auth/session";
import { getCache } from "../cache";
import { readBodyWithLimit } from "../httpBody";
import {
  checkPlaygroundRateLimit,
  contentCacheKey,
  readCachedValue,
  truncateOutput,
  validateSingleFileLessonRequest,
  writeCachedValue,
} from "../playgroundProxy";
import {
  parseZigPlaygroundFormatResult,
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
//  2. HTTP 400 is overloaded. `zig run` exits non-zero when the program fails
//     to COMPILE, when it compiles and then PANICS, and when it simply exits
//     with a non-zero code — the upstream answers 400 for all three, and for
//     its own service failures too. Those are completely different things to a
//     learner, so classifyFailure below only calls a body a compile failure
//     when it actually carries compiler diagnostics.
//
// The upstream also rate-limits at 5 requests per minute per client IP, and
// /server/run and /server/fmt share that one counter. Runs and formats are
// therefore charged against a single per-user window set below it, and
// deterministic outcomes of both are cached, so one lesson's repeated work
// does not spend the shared budget.
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
// Where a runaway program's output is cut, with a marker appended.
const MAX_OUTPUT_CHARS = 256 * 1024;
// A `zig fmt` diagnostic is a few lines. A longer 400 body is the service (or
// something in front of it) talking, not the learner's program.
const MAX_FORMAT_ERROR_CHARS = 16 * 1024;
// The upstream answers in text/plain, so its body needs no JSON headroom — but
// this ceiling still has to sit well clear of MAX_OUTPUT_CHARS, because a body
// that overflows it is discarded rather than truncated. zig-play.dev applies
// no output limit of its own (a print loop really does return megabytes), so
// sizing this at the output cap turned "you printed too much" into a service
// failure; the sibling routes' headroom keeps that on the truncation path.
const MAX_UPSTREAM_RESPONSE_BYTES = MAX_OUTPUT_CHARS * 6 + 64 * 1024;
const MAX_EXIT_DETAIL_CHARS = 256;
const CACHE_TTL_SECONDS = 60 * 60;
// One window for runs and formats together, deliberately below the upstream's
// own 5/minute per-IP budget, which /server/run and /server/fmt share: every
// Next Editor user shares this Worker's egress, so our ceiling has to leave
// room for other users rather than spend the whole upstream window on one
// person. Cached results are served before the window is charged, so this
// counts upstream calls rather than button presses. Both handlers therefore
// pass the one "zp:rl" prefix, where the Go and Rust routes give /run and
// /format a bucket each.
const RATE_LIMIT_UPSTREAM_CALLS_PER_MINUTE = 4;

// The upstream compiles one root source file from a single text body, so
// lessons submit exactly one file with this fixed name.
const REQUIRED_FILE_PATH = "main.zig";

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

// A stack trace frame is a source location followed by a resolved code address
// ("main.zig:5:23: 0x11d2d2c in main"). Only a process that actually started
// can produce one, so its presence is the reliable signal that the program
// compiled and then failed at runtime. Anchored to the whole frame shape at
// the start of a line, because a diagnostic echoes the offending source line
// verbatim and a learner's own string ("value: 0xff in hex") would otherwise
// read as a frame. Compiler diagnostics never carry an address, including in
// their "referenced by:" trace.
const RUNTIME_STACK_FRAME = /^\S+:\d+:\d+: 0x[0-9a-f]+ in \S+/m;
// Emitted by the panic handler, e.g. "thread 10 panic: integer overflow".
const PANIC_HEADER = /^thread \d+ panic: (.+)$/m;
// An error returned all the way out of main is reported as a bare
// "error: Name" line at column zero, then a trace. Compiler diagnostics also
// contain "error:", but always prefixed by a source location, so anchoring to
// the start of the line separates them.
const UNHANDLED_ERROR_HEADER = /^error: ([A-Za-z_][A-Za-z0-9_]*)$/m;
// Every compiler diagnostic carries a source location. Requiring one makes
// "the program never built" a positive finding instead of the fallback, which
// matters because the upstream answers 400 for ANY non-zero exit — including a
// plain std.process.exit(2) whose body is just the program's own output — and
// for its own service failures (a failed toolchain fetch returns a Go log
// dump). Calling those a compile error tells learners their code does not
// build and, because compile errors are deterministic, caches that verdict for
// an hour. The trade-off is a build failure carrying no location (a linker
// error) now reads as a runtime error; its text still reaches the learner, and
// erring that way costs a label rather than a poisoned cache entry.
const COMPILE_DIAGNOSTIC = /^\S+:\d+:\d+: error: /m;

export type ZigFailureClassification =
  | { status: "compile-error" }
  | { status: "runtime-error"; exitDetail: string };

/**
 * Split an upstream failure body into "the program never built" and "the
 * program built, ran, and then stopped". The upstream reports both as HTTP 400.
 */
export function classifyFailure(body: string): ZigFailureClassification {
  const hasDiagnostic = COMPILE_DIAGNOSTIC.test(body);
  const hasStackFrame = RUNTIME_STACK_FRAME.test(body);
  // Inside a compile failure, a panic or unhandled-error header is the
  // learner's own source echoed back under a diagnostic — unless a real stack
  // frame proves a process ran.
  const headersAreTrustworthy = hasStackFrame || !hasDiagnostic;

  const panic = headersAreTrustworthy ? PANIC_HEADER.exec(body) : null;
  if (panic) {
    return { status: "runtime-error", exitDetail: `panic: ${panic[1].trim()}` };
  }

  const unhandled = headersAreTrustworthy ? UNHANDLED_ERROR_HEADER.exec(body) : null;
  if (unhandled) {
    return { status: "runtime-error", exitDetail: `unhandled error: ${unhandled[1]}` };
  }

  if (hasStackFrame) {
    return { status: "runtime-error", exitDetail: "Program exited with an error" };
  }

  if (hasDiagnostic) {
    return { status: "compile-error" };
  }

  return { status: "runtime-error", exitDetail: "Program exited with a non-zero status" };
}

/**
 * Normalize the upstream run response. The upstream speaks text/plain, so the
 * HTTP status plus the body text is the entire signal:
 *   200 -> the program compiled, ran, and exited zero
 *   400 -> it failed to build, OR it ran and then exited non-zero
 * Any other status is not a program outcome and returns null, which the
 * caller turns into a 502 rather than a successful empty run.
 */
export function normalizeUpstreamRunResponse(
  httpStatus: number,
  body: string,
): ZigPlaygroundRunResult | null {
  const scrubbed = scrubUpstreamPaths(body);

  if (httpStatus === 200) {
    return { status: "success", output: truncateOutput(scrubbed, MAX_OUTPUT_CHARS) };
  }

  if (httpStatus !== 400) {
    return null;
  }

  const classified = classifyFailure(scrubbed);
  if (classified.status === "compile-error") {
    return {
      status: "compile-error",
      output: "",
      compileErrors: truncateOutput(scrubbed, MAX_OUTPUT_CHARS),
    };
  }

  return {
    status: "runtime-error",
    output: truncateOutput(scrubbed, MAX_OUTPUT_CHARS),
    exitDetail: classified.exitDetail.slice(0, MAX_EXIT_DETAIL_CHARS),
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
  submittedSource: string,
):
  | { kind: "result"; result: ZigPlaygroundFormatResult }
  | { kind: "source-error"; error: string }
  | null {
  if (httpStatus === 400) {
    const scrubbed = scrubUpstreamPaths(body).replace(/^<stdin>/gm, REQUIRED_FILE_PATH);
    // Anything past the diagnostic cap is the service talking, and relaying it
    // would show the learner a foreign page as an error in their own program.
    if (!scrubbed.trim() || scrubbed.length > MAX_FORMAT_ERROR_CHARS) {
      return null;
    }
    return { kind: "source-error", error: scrubbed };
  }

  if (httpStatus !== 200) {
    return null;
  }

  if (new TextEncoder().encode(body).byteLength > MAX_SOURCE_BYTES) {
    return null;
  }

  // The panel writes whatever comes back over the learner's main.zig, so a
  // blank formatting of a non-blank program has to fail as a service error
  // rather than silently emptying the file. (Blank source formats to blank
  // output, which is a real result.)
  if (!body.trim() && submittedSource.trim()) {
    return null;
  }

  return {
    kind: "result",
    result: { files: [{ path: REQUIRED_FILE_PATH, content: body }] },
  };
}

// Content-addressed cache keys. The pinned compiler version is folded into the
// prefix so a version change can never serve results produced by a different
// compiler, and runs and formats use distinct prefixes so a stored format can
// never be read back as a run result for the same source.
const RUN_CACHE_KEY_PREFIX = `zp:${UPSTREAM_ZIG_VERSION}`;
const FORMAT_CACHE_KEY_PREFIX = `zp:fmt:${UPSTREAM_ZIG_VERSION}`;
// Named once so the rate-limit and cache diagnostics this route emits stay
// distinguishable from the sibling routes' in the Worker log.
const LOG_LABEL = "Zig Playground";

// Aggregate telemetry only — never sources, output, or diagnostics text.
function logRun(entry: {
  outcome:
    | ZigPlaygroundRunResult["status"]
    | "upstream-error"
    | "upstream-timeout"
    | "upstream-busy";
  sourceBytes: number;
  cacheHit: boolean;
  durationMs: number;
}): void {
  console.log("zig-playground-run", entry);
}

function logFormat(entry: {
  outcome: "success" | "source-error" | "upstream-error" | "upstream-timeout" | "upstream-busy";
  sourceBytes: number;
  cacheHit: boolean;
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

  const request = await validateSingleFileLessonRequest(c.req.raw, {
    requiredPath: REQUIRED_FILE_PATH,
    language: "Zig",
    maxSourceBytes: MAX_SOURCE_BYTES,
    maxRequestBytes: MAX_REQUEST_BYTES,
  });
  if (!request.ok) {
    return request.status === 413
      ? c.json({ error: request.error }, 413)
      : c.json({ error: request.error }, 400);
  }
  const { code, sourceBytes } = request;

  const cache = getCache(c.env);
  const startedAt = Date.now();
  const cacheKey = await contentCacheKey(RUN_CACHE_KEY_PREFIX, code);
  const cachedResult = await readCachedValue(
    cache,
    cacheKey,
    parseZigPlaygroundRunResult,
    LOG_LABEL,
  );
  if (cachedResult) {
    logRun({
      outcome: cachedResult.status,
      sourceBytes,
      cacheHit: true,
      durationMs: Date.now() - startedAt,
    });
    return c.json(cachedResult);
  }

  // Charged only once the request is really going upstream, so re-running
  // unchanged source never spends a slot a Format may need.
  const rateLimitDecision = await checkPlaygroundRateLimit(cache, {
    userId: user.id,
    keyPrefix: "zp:rl",
    limit: RATE_LIMIT_UPSTREAM_CALLS_PER_MINUTE,
    label: LOG_LABEL,
  });
  if (rateLimitDecision === "limited") {
    return c.json({ error: "rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Zig Playground execution policy is unavailable" }, 502);
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

  // Backpressure: our own window sits below the upstream's per-IP budget, so
  // reaching the upstream's limit means somebody else spent it. Reported as a
  // 502 rather than a 429, because the client renders a 429 as "Too many runs"
  // — which blames a learner who pressed Run once. The distinction stays
  // visible in telemetry through the upstream-busy outcome, matching Haskell.
  if (upstreamResponse.status === 429) {
    logRun({
      outcome: "upstream-busy",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Zig Playground is busy; try again shortly" }, 502);
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
    await writeCachedValue(cache, cacheKey, result, CACHE_TTL_SECONDS, LOG_LABEL);
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

  const request = await validateSingleFileLessonRequest(c.req.raw, {
    requiredPath: REQUIRED_FILE_PATH,
    language: "Zig",
    maxSourceBytes: MAX_SOURCE_BYTES,
    maxRequestBytes: MAX_REQUEST_BYTES,
  });
  if (!request.ok) {
    return request.status === 413
      ? c.json({ error: request.error }, 413)
      : c.json({ error: request.error }, 400);
  }

  const cache = getCache(c.env);
  const startedAt = Date.now();
  // `zig fmt` is a pure function of the source, so a repeat format is as
  // deterministic as a repeat run and must not spend the shared upstream
  // budget again.
  const cacheKey = await contentCacheKey(FORMAT_CACHE_KEY_PREFIX, request.code);
  const cachedFormat = await readCachedValue(
    cache,
    cacheKey,
    parseZigPlaygroundFormatResult,
    LOG_LABEL,
  );
  if (cachedFormat) {
    logFormat({
      outcome: "success",
      sourceBytes: request.sourceBytes,
      cacheHit: true,
      durationMs: Date.now() - startedAt,
    });
    return c.json(cachedFormat);
  }

  const rateLimitDecision = await checkPlaygroundRateLimit(cache, {
    userId: user.id,
    keyPrefix: "zp:rl",
    limit: RATE_LIMIT_UPSTREAM_CALLS_PER_MINUTE,
    label: LOG_LABEL,
  });
  if (rateLimitDecision === "limited") {
    return c.json({ error: "rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Zig Playground formatting policy is unavailable" }, 502);
  }

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
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return timedOut
      ? c.json({ error: "formatting took too long" }, 504)
      : c.json({ error: "the Zig Playground formatter is unavailable" }, 502);
  }

  // Somebody else's load against the shared upstream budget — see the run
  // handler's note on why this is not reported to the learner as a 429.
  if (upstreamResponse.status === 429) {
    logFormat({
      outcome: "upstream-busy",
      sourceBytes: request.sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Zig Playground is busy; try again shortly" }, 502);
  }

  const upstreamBody = await readBodyWithLimit(upstreamResponse, MAX_UPSTREAM_RESPONSE_BYTES);
  if (upstreamBody.status === "read-error" && upstreamSignal.aborted) {
    logFormat({
      outcome: "upstream-timeout",
      sourceBytes: request.sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "formatting took too long" }, 504);
  }

  const normalized =
    upstreamBody.status === "ok"
      ? normalizeUpstreamFormatResponse(upstreamResponse.status, upstreamBody.text, request.code)
      : null;

  if (!normalized) {
    logFormat({
      outcome: "upstream-error",
      sourceBytes: request.sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Zig Playground formatter returned an unexpected response" }, 502);
  }

  if (normalized.kind === "source-error") {
    logFormat({
      outcome: "source-error",
      sourceBytes: request.sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: normalized.error }, 422);
  }

  await writeCachedValue(cache, cacheKey, normalized.result, CACHE_TTL_SECONDS, LOG_LABEL);

  logFormat({
    outcome: "success",
    sourceBytes: request.sourceBytes,
    cacheHit: false,
    durationMs: Date.now() - startedAt,
  });
  return c.json(normalized.result);
});
