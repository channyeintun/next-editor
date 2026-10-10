import { Hono } from "hono";
import type { Env } from "../env";
import { getCache } from "../cache";
import { readBodyWithLimit } from "../httpBody";
import {
  PLAYGROUND_CACHE_TTL_SECONDS,
  PLAYGROUND_MAX_EXIT_DETAIL_CHARS,
  PLAYGROUND_MAX_FORMAT_ERROR_CHARS,
  PLAYGROUND_MAX_OUTPUT_CHARS,
  PLAYGROUND_MAX_SOURCE_BYTES,
  PLAYGROUND_MAX_UPSTREAM_RESPONSE_BYTES,
  PLAYGROUND_SINGLE_FILE_MAX_REQUEST_BYTES,
  PLAYGROUND_UPSTREAM_TIMEOUT_MS,
  callUpstream,
  contentCacheKey,
  isCacheableRunResult,
  playgroundRateLimitKey,
  readCachedValue,
  truncateOutput,
  validateSingleFileLessonRequest,
  writeCachedValue,
} from "../playgroundProxy";
import { checkRateLimit } from "../rateLimit";
import { requestWaitUntil } from "../waitUntil";
import {
  parseRustPlaygroundRunResult,
  type RustPlaygroundFormatResult,
  type RustPlaygroundRunResult,
} from "../../../src/runtime/rustPlayground/types";

// Mounted at /api/rust-playground in worker/index.ts. First-party proxy in
// front of the official Rust Playground execute and format APIs
// (play.rust-lang.org) for pure Rust lessons, mirroring the Go and Kotlin
// routes. The browser never calls the upstream service directly: this route
// owns the kill switch, program-size checks, rate limiting, content-hash
// caching, the unique user agent, the upstream timeout, and normalization of
// the upstream response into the app's RustPlaygroundRunResult contract. Run
// and Format need no sign-in: a signed-in learner is rate-limited by user id,
// a signed-out one by client IP (playgroundRateLimitKey in
// ../playgroundProxy.ts).
//
// Privacy invariant: user sources, program output, and diagnostics must never
// be logged — telemetry is aggregate fields only (see logRun below). Nothing
// application-specific (cookies, tokens, user identity, the client IP) is sent
// upstream, and the client IP is never logged.

const UPSTREAM_EXECUTE_URL = "https://play.rust-lang.org/execute";
const UPSTREAM_FORMAT_URL = "https://play.rust-lang.org/format";
// The compiler configuration is pinned and folded into the cache-key prefix
// so a config change can never serve results produced under different flags.
const UPSTREAM_CHANNEL = "stable";
const UPSTREAM_MODE = "debug";
const UPSTREAM_EDITION = "2024";
// Identifies Next Editor traffic to the upstream service, matching the other
// playground routes' third-party client etiquette.
const UPSTREAM_USER_AGENT = "NextEditor-RustPlayground/1.0 (+https://nexteditor.dev)";
// The limits are the shared PLAYGROUND_* ones (../playgroundProxy.ts). The
// upstream itself deadlines runaway programs at ~10s (returning HTTP 500 with
// a timeout error), and Rust compilation can take a few seconds on top, which
// the shared 20s upstream timeout leaves room for.

// The upstream compiles one crate from a single source string, so lessons
// submit exactly one file with this fixed name.
const REQUIRED_FILE_PATH = "main.rs";

// Cargo's build-status lines share stderr with rustc diagnostics and the
// program's own stderr. Strip exactly the status lines; warnings, errors, and
// program output keep flowing through.
const CARGO_STATUS_LINE = /^\s+(Compiling|Finished|Running)\s.*$/;
// The Running line is also the discriminator between "the build failed" and
// "the program ran and then failed". Spaces and tabs, not \s: with the m flag,
// \s would let the match start on one line and run across blank lines, which
// both misreads diagnostics and retries from every line start of a long run
// of blank lines (quadratic time on the raw, untruncated stderr).
const CARGO_RUNNING_LINE = /^[ \t]+Running[ \t]`/m;

function stripCargoStatusLines(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !CARGO_STATUS_LINE.test(line))
    .join("\n")
    .replace(/^\n+/, "");
}

/**
 * Normalize the upstream execute response. Only the fields verified against
 * the live service are read (success, exitDetail, stdout, stderr); unknown
 * fields are ignored. Any field with an unexpected type makes the whole
 * payload invalid — the caller turns that into a 502, never a successful
 * empty run.
 */
export function normalizeUpstreamExecuteResponse(payload: unknown): RustPlaygroundRunResult | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const body = payload as Record<string, unknown>;
  if (
    typeof body.success !== "boolean" ||
    typeof body.stdout !== "string" ||
    typeof body.stderr !== "string"
  ) {
    return null;
  }
  const exitDetail = body.exitDetail == null ? "" : body.exitDetail;
  if (typeof exitDetail !== "string") {
    return null;
  }

  const cleanedStderr = truncateOutput(
    stripCargoStatusLines(body.stderr),
    PLAYGROUND_MAX_OUTPUT_CHARS,
  );
  const stdout = truncateOutput(body.stdout, PLAYGROUND_MAX_OUTPUT_CHARS);

  if (body.success) {
    return { status: "success", stdout, stderr: cleanedStderr };
  }

  if (!CARGO_RUNNING_LINE.test(body.stderr)) {
    // The program never started: everything on stderr is build diagnostics.
    return cleanedStderr.trim()
      ? { status: "compile-error", stdout: "", stderr: "", compileErrors: cleanedStderr }
      : null;
  }

  return {
    status: "runtime-error",
    stdout,
    stderr: cleanedStderr,
    exitDetail:
      exitDetail.trim().slice(0, PLAYGROUND_MAX_EXIT_DETAIL_CHARS) ||
      "Program exited with an error",
  };
}

export function normalizeUpstreamFormatResponse(
  payload: unknown,
):
  | { kind: "result"; result: RustPlaygroundFormatResult }
  | { kind: "source-error"; error: string }
  | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const body = payload as Record<string, unknown>;
  if (typeof body.success !== "boolean") {
    return null;
  }

  if (!body.success) {
    const stderr = body.stderr;
    if (
      typeof stderr !== "string" ||
      !stderr.trim() ||
      stderr.length > PLAYGROUND_MAX_FORMAT_ERROR_CHARS
    ) {
      return null;
    }
    return { kind: "source-error", error: stderr };
  }

  const code = body.code;
  if (
    typeof code !== "string" ||
    new TextEncoder().encode(code).byteLength > PLAYGROUND_MAX_SOURCE_BYTES
  ) {
    return null;
  }

  return {
    kind: "result",
    result: { files: [{ path: REQUIRED_FILE_PATH, content: code }] },
  };
}

// Content-addressed cache key. The pinned channel/mode/edition are folded
// into the prefix so a config change can never serve results produced under
// different flags.
const CACHE_KEY_PREFIX = `rp:${UPSTREAM_CHANNEL}-${UPSTREAM_MODE}-${UPSTREAM_EDITION}`;
// Named once so the rate-limit and cache diagnostics this route emits stay
// distinguishable from the sibling routes' in the Worker log.
const LOG_LABEL = "Rust Playground";

// Aggregate telemetry only — never sources, output, or diagnostics text.
function logRun(entry: {
  outcome: RustPlaygroundRunResult["status"] | "upstream-error" | "upstream-timeout";
  sourceBytes: number;
  cacheHit: boolean;
  durationMs: number;
}): void {
  console.log("rust-playground-run", entry);
}

function logFormat(entry: {
  outcome: "success" | "source-error" | "upstream-error" | "upstream-timeout";
  sourceBytes: number;
  durationMs: number;
}): void {
  console.log("rust-playground-format", entry);
}

// The upstream reports its own execution deadline as HTTP 500 with a JSON
// error naming the timeout; surface that as a bounded 504 like a transport
// timeout, not a 502.
async function isUpstreamTimeoutResponse(response: Response): Promise<boolean> {
  if (response.status !== 500) {
    return false;
  }
  const body = await readBodyWithLimit(response, 16 * 1024);
  if (body.status !== "ok") {
    return false;
  }
  try {
    const parsed = JSON.parse(body.text) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.includes("timed out");
  } catch {
    return false;
  }
}

export const rustPlaygroundRoute = new Hono<{ Bindings: Env }>();

rustPlaygroundRoute.post("/run", async (c) => {
  // Shared Rust-tool kill switch fails closed unless explicitly enabled.
  // Editing and recorded playback never touch either live route.
  if (c.env.RUST_PLAYGROUND_ENABLED !== "true") {
    return c.json({ error: "Rust Playground execution is disabled" }, 503);
  }

  const request = await validateSingleFileLessonRequest(c.req.raw, {
    requiredPath: REQUIRED_FILE_PATH,
    language: "Rust",
    maxSourceBytes: PLAYGROUND_MAX_SOURCE_BYTES,
    maxRequestBytes: PLAYGROUND_SINGLE_FILE_MAX_REQUEST_BYTES,
  });
  if (!request.ok) {
    return c.json({ error: request.error }, request.status);
  }
  const { code, sourceBytes } = request;

  const cache = getCache(c.env);
  const startedAt = Date.now();

  // The cache is consulted before the rate limit, deliberately. The ceiling
  // exists to protect the upstream, and a cache hit never reaches it — a
  // learner re-running an unchanged main.rs while reading its output would
  // otherwise spend the whole minute's budget on requests that cost the
  // upstream nothing, and be refused on the first run that needed compiling.
  const cacheKey = await contentCacheKey(CACHE_KEY_PREFIX, code);
  const cachedResult = await readCachedValue(
    cache,
    cacheKey,
    parseRustPlaygroundRunResult,
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

  // The run budget is RUST_RUN_RATE_LIMITER's, set in infra/wrangler.toml.
  const rateLimitDecision = await checkRateLimit(c.env.RUST_RUN_RATE_LIMITER, {
    key: await playgroundRateLimitKey(c),
    label: LOG_LABEL,
  });
  if (rateLimitDecision === "limited") {
    return c.json({ error: "rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Rust Playground execution policy is unavailable" }, 502);
  }

  const call = await callUpstream(
    UPSTREAM_EXECUTE_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      body: JSON.stringify({
        channel: UPSTREAM_CHANNEL,
        mode: UPSTREAM_MODE,
        edition: UPSTREAM_EDITION,
        crateType: "bin",
        tests: false,
        code,
        backtrace: false,
      }),
    },
    PLAYGROUND_UPSTREAM_TIMEOUT_MS,
  );
  if (call.kind !== "response") {
    logRun({
      outcome: call.kind === "timeout" ? "upstream-timeout" : "upstream-error",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return call.kind === "timeout"
      ? c.json({ error: "the program took too long to compile and run" }, 504)
      : c.json({ error: "the Rust Playground service is unavailable" }, 502);
  }

  let result: RustPlaygroundRunResult | null = null;
  if (call.response.ok) {
    const upstreamBody = await call.readBody(PLAYGROUND_MAX_UPSTREAM_RESPONSE_BYTES);
    if (upstreamBody.status === "timeout") {
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
        result = normalizeUpstreamExecuteResponse(JSON.parse(upstreamBody.text));
      } catch {
        result = null;
      }
    }
  } else if (await isUpstreamTimeoutResponse(call.response)) {
    logRun({
      outcome: "upstream-timeout",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the program took too long to compile and run" }, 504);
  }

  if (!result) {
    logRun({
      outcome: "upstream-error",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Rust Playground service returned an unexpected response" }, 502);
  }

  if (isCacheableRunResult(result)) {
    await writeCachedValue(
      cache,
      cacheKey,
      result,
      PLAYGROUND_CACHE_TTL_SECONDS,
      LOG_LABEL,
      requestWaitUntil(c),
    );
  }

  logRun({
    outcome: result.status,
    sourceBytes,
    cacheHit: false,
    durationMs: Date.now() - startedAt,
  });
  return c.json(result);
});

rustPlaygroundRoute.post("/format", async (c) => {
  if (c.env.RUST_PLAYGROUND_ENABLED !== "true") {
    return c.json({ error: "Rust Playground tools are disabled" }, 503);
  }

  const request = await validateSingleFileLessonRequest(c.req.raw, {
    requiredPath: REQUIRED_FILE_PATH,
    language: "Rust",
    maxSourceBytes: PLAYGROUND_MAX_SOURCE_BYTES,
    maxRequestBytes: PLAYGROUND_SINGLE_FILE_MAX_REQUEST_BYTES,
  });
  if (!request.ok) {
    return c.json({ error: request.error }, request.status);
  }

  // The format budget is RUST_FORMAT_RATE_LIMITER's, set in infra/wrangler.toml.
  const rateLimitDecision = await checkRateLimit(c.env.RUST_FORMAT_RATE_LIMITER, {
    key: await playgroundRateLimitKey(c),
    label: LOG_LABEL,
  });
  if (rateLimitDecision === "limited") {
    return c.json({ error: "format rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Rust Playground formatting policy is unavailable" }, 502);
  }

  const startedAt = Date.now();
  const call = await callUpstream(
    UPSTREAM_FORMAT_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      body: JSON.stringify({
        channel: UPSTREAM_CHANNEL,
        edition: UPSTREAM_EDITION,
        code: request.code,
      }),
    },
    PLAYGROUND_UPSTREAM_TIMEOUT_MS,
  );
  if (call.kind !== "response") {
    logFormat({
      outcome: call.kind === "timeout" ? "upstream-timeout" : "upstream-error",
      sourceBytes: request.sourceBytes,
      durationMs: Date.now() - startedAt,
    });
    return call.kind === "timeout"
      ? c.json({ error: "formatting took too long" }, 504)
      : c.json({ error: "the Rust Playground formatter is unavailable" }, 502);
  }

  let normalized: ReturnType<typeof normalizeUpstreamFormatResponse> = null;
  if (call.response.ok) {
    const upstreamBody = await call.readBody(PLAYGROUND_MAX_UPSTREAM_RESPONSE_BYTES);
    if (upstreamBody.status === "timeout") {
      logFormat({
        outcome: "upstream-timeout",
        sourceBytes: request.sourceBytes,
        durationMs: Date.now() - startedAt,
      });
      return c.json({ error: "formatting took too long" }, 504);
    }
    if (upstreamBody.status === "ok") {
      try {
        normalized = normalizeUpstreamFormatResponse(JSON.parse(upstreamBody.text));
      } catch {
        normalized = null;
      }
    }
  }

  if (!normalized) {
    logFormat({
      outcome: "upstream-error",
      sourceBytes: request.sourceBytes,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Rust Playground formatter returned an unexpected response" }, 502);
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
