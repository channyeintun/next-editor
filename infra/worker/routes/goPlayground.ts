import { Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser } from "../auth/session";
import { getCache } from "../cache";
import type { GoPlaygroundRunResult } from "../../../src/runtime/goPlayground/types";

// Mounted at /api/go-playground in worker/index.ts. First-party proxy in
// front of the official Go Playground compile API for pure Go lessons
// (docs/go-lessons-selective-runtime-plan.md §7.2). The browser never calls
// the upstream service directly: this route owns the kill switch,
// authentication, source-size checks, per-user rate limiting, content-hash
// caching, the unique user agent, the upstream timeout, and normalization of
// the upstream response into the app's GoPlaygroundRunResult contract.
//
// Privacy invariant: user source, program output, and diagnostics must never
// be logged — telemetry is aggregate fields only (see logRun below). Nothing
// application-specific (cookies, tokens, user identity) is sent upstream.

const UPSTREAM_COMPILE_URL = "https://play.golang.org/compile";
// Identifies Next Editor traffic as the Go project asks of third-party
// clients. Confirm this string with the Playground maintainers before public
// production rollout (plan §8 Phase 0).
const UPSTREAM_USER_AGENT = "NextEditor-GoPlayground/1.0 (+https://nexteditor.dev)";
// Shorter than the application request ceiling so a hung upstream surfaces as
// a bounded 504 instead of an opaque Worker timeout.
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_SOURCE_BYTES = 64 * 1024;
// Defensive bound on concatenated event output; the Playground applies its
// own output limits well below this.
const MAX_OUTPUT_CHARS = 256 * 1024;
const CACHE_TTL_SECONDS = 60 * 60;
const RATE_LIMIT_RUNS_PER_MINUTE = 10;

/**
 * Normalize the upstream compile response. Only the fields `learn-go` proved
 * out are read (Errors, VetErrors, Events[].Message, Status, IsTest,
 * TestsFailed); unknown fields are ignored. Any field with an unexpected type
 * makes the whole payload invalid — the caller turns that into a 502, never a
 * successful empty run.
 */
export function normalizeUpstreamCompileResponse(payload: unknown): GoPlaygroundRunResult | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const body = payload as Record<string, unknown>;
  const readString = (value: unknown) =>
    typeof value === "string" ? value : value == null ? "" : null;

  const compileErrors = readString(body.Errors);
  const vetErrors = readString(body.VetErrors);
  if (compileErrors === null || vetErrors === null) {
    return null;
  }

  const exitStatus =
    body.Status == null
      ? 0
      : typeof body.Status === "number" && Number.isInteger(body.Status)
        ? body.Status
        : null;
  if (exitStatus === null) {
    return null;
  }

  const events = body.Events == null ? [] : Array.isArray(body.Events) ? body.Events : null;
  if (events === null) {
    return null;
  }

  let output = "";
  for (const event of events) {
    if (typeof event !== "object" || event === null) {
      return null;
    }
    const message = (event as Record<string, unknown>).Message;
    if (typeof message !== "string") {
      return null;
    }
    output += message;
  }
  if (output.length > MAX_OUTPUT_CHARS) {
    output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;
  }

  const result: GoPlaygroundRunResult = compileErrors.trim()
    ? { status: "compile-error", output, compileErrors }
    : vetErrors.trim()
      ? { status: "vet-error", output, vetErrors, exitCode: exitStatus }
      : exitStatus !== 0
        ? { status: "runtime-error", output, exitCode: exitStatus }
        : { status: "success", output, exitCode: 0 };

  if (body.IsTest === true) {
    result.isTest = true;
  }
  if (typeof body.TestsFailed === "number" && Number.isInteger(body.TestsFailed)) {
    result.testsFailed = body.TestsFailed;
  }

  return result;
}

// Content-addressed cache key. The fixed upstream request flags (version=2,
// withVet=true) are folded into the prefix so a future flag change can never
// serve results produced under different flags.
async function cacheKeyForSource(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `gp:v2-vet:${hex}`;
}

// Fixed-window per-user limit in KV. Approximate by design (KV is eventually
// consistent) and degrades open on cache errors — an abuse bound, not a
// billing meter. Requests without a cache binding are not limited.
async function isRateLimited(cache: KVNamespace | null, userId: string): Promise<boolean> {
  if (!cache) {
    return false;
  }
  const windowKey = `gp:rl:${userId}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const count = Number((await cache.get(windowKey)) ?? "0");
    if (count >= RATE_LIMIT_RUNS_PER_MINUTE) {
      return true;
    }
    await cache.put(windowKey, String(count + 1), { expirationTtl: 120 });
  } catch (error) {
    console.error("Go Playground rate-limit check failed", error);
  }
  return false;
}

async function readCachedResult(
  cache: KVNamespace | null,
  key: string,
): Promise<GoPlaygroundRunResult | null> {
  if (!cache) {
    return null;
  }
  try {
    return await cache.get<GoPlaygroundRunResult>(key, "json");
  } catch (error) {
    console.error("Go Playground cache read failed", error);
    return null;
  }
}

async function writeCachedResult(
  cache: KVNamespace | null,
  key: string,
  result: GoPlaygroundRunResult,
): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    await cache.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  } catch (error) {
    console.error("Go Playground cache write failed", error);
  }
}

// Aggregate telemetry only — never source, output, or diagnostics text.
function logRun(entry: {
  outcome: GoPlaygroundRunResult["status"] | "upstream-error" | "upstream-timeout";
  sourceBytes: number;
  cacheHit: boolean;
  durationMs: number;
}): void {
  console.log("go-playground-run", entry);
}

export const goPlaygroundRoute = new Hono<{ Bindings: Env }>();

goPlaygroundRoute.post("/run", async (c) => {
  // Kill switch fails closed: live execution off unless explicitly enabled.
  // Editing and recorded playback never touch this route, so flipping the
  // flag only disables live Run.
  if (c.env.GO_PLAYGROUND_ENABLED !== "true") {
    return c.json({ error: "Go Playground execution is disabled" }, 503);
  }

  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const source = (body as { source?: unknown }).source;
  if (typeof source !== "string" || source.trim().length === 0) {
    return c.json({ error: "'source' must be a non-empty string" }, 400);
  }

  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > MAX_SOURCE_BYTES) {
    return c.json({ error: `source exceeds ${MAX_SOURCE_BYTES} bytes` }, 413);
  }

  // Cheap contract check: v1 Go lessons are a single `package main` program.
  // Anything else would fail upstream anyway; rejecting here avoids the call.
  if (!/\bpackage\s+main\b/.test(source)) {
    return c.json({ error: "Go lessons run a single 'package main' program" }, 400);
  }

  const cache = getCache(c.env);
  if (await isRateLimited(cache, user.id)) {
    return c.json({ error: "rate limit exceeded; retry in a minute" }, 429);
  }

  const startedAt = Date.now();
  const cacheKey = await cacheKeyForSource(source);
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

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(UPSTREAM_COMPILE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      body: new URLSearchParams({ version: "2", body: source, withVet: "true" }).toString(),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    logRun({
      outcome: timedOut ? "upstream-timeout" : "upstream-error",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return timedOut
      ? c.json({ error: "the program took too long to compile and run" }, 504)
      : c.json({ error: "the Go Playground service is unavailable" }, 502);
  }

  let result: GoPlaygroundRunResult | null = null;
  if (upstreamResponse.ok) {
    try {
      result = normalizeUpstreamCompileResponse(await upstreamResponse.json());
    } catch {
      result = null;
    }
  }

  if (!result) {
    logRun({
      outcome: "upstream-error",
      sourceBytes,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ error: "the Go Playground service returned an unexpected response" }, 502);
  }

  // Only successful and compiler-error responses are cached (plan §7.2);
  // other categories always re-run.
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
