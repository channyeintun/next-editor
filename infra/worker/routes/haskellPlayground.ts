import { Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser } from "../auth/session";
import { getCache } from "../cache";
import { readBodyWithLimit } from "../httpBody";
import {
  parseHaskellPlaygroundRunResult,
  type HaskellPlaygroundRunResult,
} from "../../../src/runtime/haskellPlayground/types";

// Mounted at /api/haskell-playground in worker/index.ts. First-party proxy in
// front of the community Haskell Playground submit API (play.haskell.org) for
// pure Haskell lessons, mirroring the Go, Kotlin, Rust, and Zig routes. The
// browser never calls the upstream service directly: this route owns the kill
// switch, authentication, program-size checks, per-user rate limiting,
// content-hash caching, the unique user agent, the upstream timeout, and
// normalization of the upstream response into the app's
// HaskellPlaygroundRunResult contract.
//
// Three upstream properties shape everything below:
//
//  1. The response is JSON with the compiler's output in its own field. GHC's
//     diagnostics arrive as `ghcout`, while `sout`/`serr` are the program's
//     own streams. That makes "did it build?" a field read rather than the
//     text sniffing routes/zigPlayground.ts has to do, so nothing here
//     resembles that route's classifyFailure. What it does NOT give us is the
//     difference between a warning and an error, since both land in `ghcout` —
//     hence GHC_ERROR_DIAGNOSTIC below.
//  2. There is no formatter endpoint at all, so this route is run-only like
//     routes/kotlinPlayground.ts. No /format, no Format button, nothing
//     downstream needs a staleness guard.
//  3. The service is a small shared community pool. It deadlines a running
//     program at 5 seconds, truncates each of ghcout/sout/serr at 100,000
//     bytes itself, and answers HTTP 503 "Service busy" when every worker in
//     the pool is occupied. Our per-user ceiling and the deterministic-result
//     cache below exist so one lesson's repeated runs do not push it there.
//
// Privacy invariant: user sources, program output, and diagnostics must never
// be logged — telemetry is aggregate fields only (see logRun below). Nothing
// application-specific (cookies, tokens, user identity) is sent upstream.

const UPSTREAM_URL = "https://play.haskell.org/submit";
// The compiler version is pinned and folded into the cache-key prefix so a
// version change can never serve results produced by a different compiler.
// The upstream lists what it currently has at GET /versions; a lesson's
// recorded output must stay reproducible, so this is never "latest".
const UPSTREAM_GHC_VERSION = "9.12.4";
// Optimization level, also folded into the cache key. O1 matches what the
// playground's own UI submits, so a learner comparing the two sees the same
// warnings — O0 suppresses some of GHC's flow-sensitive ones.
const UPSTREAM_OPT = "O1";
// The submit API can also return Core or assembly; lessons only ever run.
const UPSTREAM_OUTPUT = "run";
// Identifies Next Editor traffic to the upstream service, matching the other
// playground routes' third-party client etiquette.
const UPSTREAM_USER_AGENT = "NextEditor-HaskellPlayground/1.0 (+https://nexteditor.dev)";
// The upstream deadlines a running program at 5s and reports that itself, so
// this bound only has to cover queueing plus GHC's compile time; keep the same
// 20s ceiling the other playground routes use.
const UPSTREAM_TIMEOUT_MS = 20_000;
// Also has to stay clear of the upstream's own limit: it rejects a request
// body over 1,000,000 bytes with "Program too large". 64 KiB of source can
// only ever serialize to a fraction of that, so a lesson program that passes
// this check can never trip theirs.
const MAX_SOURCE_BYTES = 64 * 1024;
// JSON escaping can expand one source byte to six bytes. Leave bounded room
// for the file path and object syntax while allowing every valid program.
const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES * 6 + 4096;
// Defensive bound on normalized program output; the Playground truncates each
// of its three streams at 100,000 bytes, well below this.
const MAX_OUTPUT_CHARS = 256 * 1024;
// Bound upstream JSON before decoding it. JSON escaping can expand each output
// character to six bytes; the remainder leaves room for diagnostics/metadata.
const MAX_UPSTREAM_RESPONSE_BYTES = MAX_OUTPUT_CHARS * 6 + 64 * 1024;
const MAX_EXIT_DETAIL_CHARS = 256;
const CACHE_TTL_SECONDS = 60 * 60;
// The upstream publishes no per-IP budget, but every run occupies one worker
// in a small shared community pool for seconds of real compile time, and the
// service answers 503 once that pool saturates. So this sits below the 10/min
// the Rust and Kotlin routes allow against far larger hosted services, and
// above the Zig route's 4/min, which is pinned by that upstream's hard
// documented 5/min per-IP cap rather than by politeness.
const RATE_LIMIT_RUNS_PER_MINUTE = 6;

// The upstream compiles one module from a single source string, so lessons
// submit exactly one file with this fixed name. Capital M: GHC names the
// module's diagnostics "Main.hs", and the editor file has to match them.
const REQUIRED_FILE_PATH = "Main.hs";

type HaskellLessonRequestValidation =
  | {
      ok: true;
      code: string;
      sourceBytes: number;
    }
  | { ok: false; status: 400 | 413; error: string };

async function validateHaskellLessonRequest(
  request: Request,
): Promise<HaskellLessonRequestValidation> {
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
      error: "Haskell lessons run exactly one Main.hs file",
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
    return { ok: false, status: 400, error: "Haskell lessons run exactly one Main.hs file" };
  }
  if (typeof fileRecord.content !== "string") {
    return { ok: false, status: 400, error: "files[0].content must be a string" };
  }

  const sourceBytes = new TextEncoder().encode(fileRecord.content).byteLength;
  if (sourceBytes > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Haskell program exceeds ${MAX_SOURCE_BYTES} bytes`,
    };
  }

  return { ok: true, code: fileRecord.content, sourceBytes };
}

function truncateOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`
    : text;
}

// GHC labels every diagnostic on its location line: "Main.hs:2:22: error:
// [GHC-83865]" versus "Main.hs:6:10: warning: [GHC-06201]". A non-zero exit
// code alone cannot tell the two apart, because a program that compiled with
// warnings and then died at runtime also exits non-zero — so the presence of
// an "error:" diagnostic is the discriminator, and the exit code only says
// that something went wrong.
//
// The tempting shortcut — "sout is empty, so nothing ran, so it must be a
// compile error" — is wrong and was rejected against real evidence:
// `print (head [])` compiles, exits 1, prints nothing on stdout, and leaves
// only a -Wx-partial WARNING in ghcout. That is a runtime error.
const GHC_ERROR_DIAGNOSTIC = /^[^\n]*:\s*error:/m;

// No path scrubbing here, deliberately, and none should be added: the upstream
// compiles the submitted source as "Main.hs", which is exactly the filename the
// learner sees in the editor, so every location in ghcout and in a HasCallStack
// trace already points at their own file. (routes/zigPlayground.ts needs
// scrubUpstreamPaths only because that service compiles at a per-run scratch
// path whose directory number changes on every request.)

/**
 * Normalize the upstream submit response. The body is either a program outcome
 * ({ec, ghcout, sout, serr, timesecs}) or a service report ({err}); `timesecs`
 * and any unknown field are dropped. Any field with an unexpected type makes
 * the whole payload invalid — the caller turns that into a 502, never a
 * successful empty run.
 *
 * The upstream's own run deadline comes back as {"err":"timeout"} with HTTP
 * 200, which is a real outcome for the learner's program rather than a
 * malformed payload, so it gets its own kind and a 504 from the caller.
 */
export function normalizeUpstreamRunResponse(
  payload: unknown,
): { kind: "result"; result: HaskellPlaygroundRunResult } | { kind: "timeout" } | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }

  const body = payload as Record<string, unknown>;

  if (body.err != null) {
    // "timeout" is the 5s run deadline. "backend" (and anything added later)
    // describes a failure of the service itself, not of the program.
    return body.err === "timeout" ? { kind: "timeout" } : null;
  }

  const { ec, ghcout, sout, serr } = body;
  if (
    typeof ec !== "number" ||
    !Number.isSafeInteger(ec) ||
    typeof ghcout !== "string" ||
    typeof sout !== "string" ||
    typeof serr !== "string"
  ) {
    return null;
  }

  const stdout = truncateOutput(sout);
  const stderr = truncateOutput(serr);
  const diagnostics = truncateOutput(ghcout);
  const hasDiagnostics = diagnostics.trim().length > 0;

  if (ec !== 0 && GHC_ERROR_DIAGNOSTIC.test(ghcout)) {
    // The build failed, so nothing ran and the whole of ghcout is the error
    // text — there is no warnings channel to split off. The streams are pinned
    // empty rather than forwarded so the "nothing ran" half of the contract
    // holds even if the upstream ever attaches stray text to a failed build.
    return {
      kind: "result",
      result: { status: "compile-error", stdout: "", stderr: "", compileErrors: diagnostics },
    };
  }

  const result: HaskellPlaygroundRunResult =
    ec === 0
      ? { status: "success", stdout, stderr }
      : {
          status: "runtime-error",
          stdout,
          stderr,
          // `ec` is already a safe integer, so this cannot truncate today; the
          // bound matches the sibling routes so the field stays bounded if the
          // upstream ever reports a signal name here instead.
          exitDetail: `Exited with status ${ec}`.slice(0, MAX_EXIT_DETAIL_CHARS),
        };

  // The program compiled, so anything in ghcout is a warning — a separate
  // channel from the program's own stderr, which the console renders under its
  // own tag rather than mixed into the run output.
  if (hasDiagnostics) {
    result.warnings = diagnostics;
  }

  return { kind: "result", result };
}

// Content-addressed cache key. The pinned compiler version and optimization
// level are folded into the prefix so a change to either can never serve
// results produced by a different compiler.
async function cacheKeyForSource(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `hp:${UPSTREAM_GHC_VERSION}-${UPSTREAM_OPT}:${hex}`;
}

// Fixed-window per-user limit in KV. Approximate by design (KV is eventually
// consistent), but fail closed when the policy store is missing or unavailable
// so a configuration outage cannot turn this route into an unlimited proxy.
type RateLimitDecision = "allowed" | "limited" | "unavailable";

async function checkRateLimit(
  cache: KVNamespace | null,
  userId: string,
): Promise<RateLimitDecision> {
  if (!cache) {
    return "unavailable";
  }
  const windowKey = `hp:rl:${userId}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const count = Number((await cache.get(windowKey)) ?? "0");
    if (!Number.isSafeInteger(count) || count < 0) {
      console.error("Haskell Playground rate-limit state was invalid");
      return "unavailable";
    }
    if (count >= RATE_LIMIT_RUNS_PER_MINUTE) {
      return "limited";
    }
    await cache.put(windowKey, String(count + 1), { expirationTtl: 120 });
    return "allowed";
  } catch {
    console.error("Haskell Playground rate-limit check failed");
    return "unavailable";
  }
}

async function readCachedResult(
  cache: KVNamespace | null,
  key: string,
): Promise<HaskellPlaygroundRunResult | null> {
  if (!cache) {
    return null;
  }
  try {
    return parseHaskellPlaygroundRunResult(await cache.get<unknown>(key, "json"));
  } catch {
    console.error("Haskell Playground cache read failed");
    return null;
  }
}

async function writeCachedResult(
  cache: KVNamespace | null,
  key: string,
  result: HaskellPlaygroundRunResult,
): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    await cache.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    console.error("Haskell Playground cache write failed");
  }
}

// Aggregate telemetry only — never sources, output, or diagnostics text.
function logRun(entry: {
  outcome:
    | HaskellPlaygroundRunResult["status"]
    | "upstream-error"
    | "upstream-timeout"
    | "upstream-busy";
  sourceBytes: number;
  cacheHit: boolean;
  durationMs: number;
}): void {
  console.log("haskell-playground-run", entry);
}

export const haskellPlaygroundRoute = new Hono<{ Bindings: Env }>();

haskellPlaygroundRoute.post("/run", async (c) => {
  // Kill switch fails closed unless explicitly enabled. Editing and recorded
  // playback never touch this route.
  if (c.env.HASKELL_PLAYGROUND_ENABLED !== "true") {
    return c.json({ error: "Haskell Playground execution is disabled" }, 503);
  }

  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const request = await validateHaskellLessonRequest(c.req.raw);
  if (!request.ok) {
    return request.status === 413
      ? c.json({ error: request.error }, 413)
      : c.json({ error: request.error }, 400);
  }
  const { code, sourceBytes } = request;

  const cache = getCache(c.env);
  const rateLimitDecision = await checkRateLimit(cache, user.id);
  if (rateLimitDecision === "limited") {
    return c.json({ error: "rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Haskell Playground execution policy is unavailable" }, 502);
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
    upstreamResponse = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      body: JSON.stringify({
        code,
        version: UPSTREAM_GHC_VERSION,
        opt: UPSTREAM_OPT,
        output: UPSTREAM_OUTPUT,
      }),
      signal: upstreamSignal,
    });
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
      : c.json({ error: "the Haskell Playground service is unavailable" }, 502);
  }

  // Backpressure: 503 "Service busy, please try again later" means every
  // worker in the shared pool is occupied. Reported as a 502 rather than a
  // 429, because a 429 tells the learner THEY ran too often — this is somebody
  // else's load, and our own per-user window is what polices their rate. The
  // 502 copy ("unavailable right now — your code is unchanged, try again
  // shortly") is the accurate thing to show, and the distinction stays visible
  // in telemetry through the upstream-busy outcome.
  if (upstreamResponse.status === 503) {
    logRun({
      outcome: "upstream-busy",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Haskell Playground is busy; try again shortly" }, 502);
  }

  let normalized: ReturnType<typeof normalizeUpstreamRunResponse> = null;
  if (upstreamResponse.ok) {
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
    if (upstreamBody.status === "ok") {
      try {
        normalized = normalizeUpstreamRunResponse(JSON.parse(upstreamBody.text));
      } catch {
        normalized = null;
      }
    }
  }

  if (normalized?.kind === "timeout") {
    logRun({
      outcome: "upstream-timeout",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the program took too long to compile and run" }, 504);
  }

  if (!normalized) {
    logRun({
      outcome: "upstream-error",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Haskell Playground service returned an unexpected response" }, 502);
  }

  const result = normalized.result;

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
