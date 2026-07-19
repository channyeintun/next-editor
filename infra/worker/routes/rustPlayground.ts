import { Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser } from "../auth/session";
import { getCache } from "../cache";
import { readBodyWithLimit } from "../httpBody";
import {
  parseRustPlaygroundRunResult,
  type RustPlaygroundFormatResult,
  type RustPlaygroundRunResult,
} from "../../../src/runtime/rustPlayground/types";

// Mounted at /api/rust-playground in worker/index.ts. First-party proxy in
// front of the official Rust Playground execute and format APIs
// (play.rust-lang.org) for pure Rust lessons, mirroring the Go and Kotlin
// routes. The browser never calls the upstream service directly: this route
// owns the kill switch, authentication, program-size checks, per-user rate
// limiting, content-hash caching, the unique user agent, the upstream
// timeout, and normalization of the upstream response into the app's
// RustPlaygroundRunResult contract.
//
// Privacy invariant: user sources, program output, and diagnostics must never
// be logged — telemetry is aggregate fields only (see logRun below). Nothing
// application-specific (cookies, tokens, user identity) is sent upstream.

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
// The upstream itself deadlines runaway programs at ~10s (returning HTTP 500
// with a timeout error); Rust compilation can take a few seconds on top, so
// keep the same 20s bound the other playground routes use.
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_SOURCE_BYTES = 64 * 1024;
// JSON escaping can expand one source byte to six bytes. Leave bounded room
// for the file path and object syntax while allowing every valid program.
const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES * 6 + 4096;
// Defensive bound on normalized program output; the Playground applies its
// own output limits well below this.
const MAX_OUTPUT_CHARS = 256 * 1024;
// Bound upstream JSON before decoding it. JSON escaping can expand each output
// character to six bytes; the remainder leaves room for diagnostics/metadata.
const MAX_UPSTREAM_RESPONSE_BYTES = MAX_OUTPUT_CHARS * 6 + 64 * 1024;
const MAX_FORMAT_ERROR_CHARS = 16 * 1024;
const MAX_EXIT_DETAIL_CHARS = 256;
const CACHE_TTL_SECONDS = 60 * 60;
const RATE_LIMIT_RUNS_PER_MINUTE = 10;
const RATE_LIMIT_FORMATS_PER_MINUTE = 20;

// The upstream compiles one crate from a single source string, so lessons
// submit exactly one file with this fixed name.
const REQUIRED_FILE_PATH = "main.rs";

type RustLessonRequestValidation =
  | {
      ok: true;
      code: string;
      sourceBytes: number;
    }
  | { ok: false; status: 400 | 413; error: string };

async function validateRustLessonRequest(request: Request): Promise<RustLessonRequestValidation> {
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
      error: "Rust lessons run exactly one main.rs file",
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
    return { ok: false, status: 400, error: "Rust lessons run exactly one main.rs file" };
  }
  if (typeof fileRecord.content !== "string") {
    return { ok: false, status: 400, error: "files[0].content must be a string" };
  }

  const sourceBytes = new TextEncoder().encode(fileRecord.content).byteLength;
  if (sourceBytes > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Rust program exceeds ${MAX_SOURCE_BYTES} bytes`,
    };
  }

  return { ok: true, code: fileRecord.content, sourceBytes };
}

// Cargo's build-status lines share stderr with rustc diagnostics and the
// program's own stderr. Strip exactly the status lines; warnings, errors, and
// program output keep flowing through.
const CARGO_STATUS_LINE = /^\s+(Compiling|Finished|Running)\s.*$/;
// The Running line is also the discriminator between "the build failed" and
// "the program ran and then failed".
const CARGO_RUNNING_LINE = /^\s+Running\s`/m;

function stripCargoStatusLines(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !CARGO_STATUS_LINE.test(line))
    .join("\n")
    .replace(/^\n+/, "");
}

function truncateOutput(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`
    : text;
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

  const cleanedStderr = truncateOutput(stripCargoStatusLines(body.stderr));
  const stdout = truncateOutput(body.stdout);

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
    exitDetail: exitDetail.trim().slice(0, MAX_EXIT_DETAIL_CHARS) || "Program exited with an error",
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
    if (typeof stderr !== "string" || !stderr.trim() || stderr.length > MAX_FORMAT_ERROR_CHARS) {
      return null;
    }
    return { kind: "source-error", error: stderr };
  }

  const code = body.code;
  if (typeof code !== "string" || new TextEncoder().encode(code).byteLength > MAX_SOURCE_BYTES) {
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
async function cacheKeyForSource(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `rp:${UPSTREAM_CHANNEL}-${UPSTREAM_MODE}-${UPSTREAM_EDITION}:${hex}`;
}

// Fixed-window per-user limit in KV. Approximate by design (KV is eventually
// consistent), but fail closed when the policy store is missing or unavailable
// so a configuration outage cannot turn this route into an unlimited proxy.
type RateLimitDecision = "allowed" | "limited" | "unavailable";

async function checkRateLimit(
  cache: KVNamespace | null,
  userId: string,
  keyPrefix: "rp:rl" | "rp:fmt:rl",
  limit: number,
): Promise<RateLimitDecision> {
  if (!cache) {
    return "unavailable";
  }
  const windowKey = `${keyPrefix}:${userId}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const count = Number((await cache.get(windowKey)) ?? "0");
    if (!Number.isSafeInteger(count) || count < 0) {
      console.error("Rust Playground rate-limit state was invalid");
      return "unavailable";
    }
    if (count >= limit) {
      return "limited";
    }
    await cache.put(windowKey, String(count + 1), { expirationTtl: 120 });
    return "allowed";
  } catch {
    console.error("Rust Playground rate-limit check failed");
    return "unavailable";
  }
}

async function readCachedResult(
  cache: KVNamespace | null,
  key: string,
): Promise<RustPlaygroundRunResult | null> {
  if (!cache) {
    return null;
  }
  try {
    return parseRustPlaygroundRunResult(await cache.get<unknown>(key, "json"));
  } catch {
    console.error("Rust Playground cache read failed");
    return null;
  }
}

async function writeCachedResult(
  cache: KVNamespace | null,
  key: string,
  result: RustPlaygroundRunResult,
): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    await cache.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    console.error("Rust Playground cache write failed");
  }
}

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

  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const request = await validateRustLessonRequest(c.req.raw);
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
    "rp:rl",
    RATE_LIMIT_RUNS_PER_MINUTE,
  );
  if (rateLimitDecision === "limited") {
    return c.json({ error: "rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Rust Playground execution policy is unavailable" }, 502);
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
    upstreamResponse = await fetch(UPSTREAM_EXECUTE_URL, {
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
      : c.json({ error: "the Rust Playground service is unavailable" }, 502);
  }

  let result: RustPlaygroundRunResult | null = null;
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
        result = normalizeUpstreamExecuteResponse(JSON.parse(upstreamBody.text));
      } catch {
        result = null;
      }
    }
  } else if (await isUpstreamTimeoutResponse(upstreamResponse)) {
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

rustPlaygroundRoute.post("/format", async (c) => {
  if (c.env.RUST_PLAYGROUND_ENABLED !== "true") {
    return c.json({ error: "Rust Playground tools are disabled" }, 503);
  }

  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const request = await validateRustLessonRequest(c.req.raw);
  if (!request.ok) {
    return request.status === 413
      ? c.json({ error: request.error }, 413)
      : c.json({ error: request.error }, 400);
  }

  const cache = getCache(c.env);
  const rateLimitDecision = await checkRateLimit(
    cache,
    user.id,
    "rp:fmt:rl",
    RATE_LIMIT_FORMATS_PER_MINUTE,
  );
  if (rateLimitDecision === "limited") {
    return c.json({ error: "format rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Rust Playground formatting policy is unavailable" }, 502);
  }

  const startedAt = Date.now();
  const upstreamSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(UPSTREAM_FORMAT_URL, {
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
      signal: upstreamSignal,
    });
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
      : c.json({ error: "the Rust Playground formatter is unavailable" }, 502);
  }

  let normalized: ReturnType<typeof normalizeUpstreamFormatResponse> = null;
  if (upstreamResponse.ok) {
    const upstreamBody = await readBodyWithLimit(upstreamResponse, MAX_UPSTREAM_RESPONSE_BYTES);
    if (upstreamBody.status === "read-error" && upstreamSignal.aborted) {
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
