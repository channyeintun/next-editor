import { Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser } from "../auth/session";
import { getCache } from "../cache";
import {
  parseGoPlaygroundRunResult,
  type GoPlaygroundRunResult,
} from "../../../src/runtime/goPlayground/types";

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
// JSON escaping can expand one source byte to six bytes (for example, a
// control character encoded as \u0000). Bound the request before parsing while
// still allowing every source that fits MAX_SOURCE_BYTES.
const MAX_REQUEST_BYTES = MAX_SOURCE_BYTES * 6 + 1024;
// Defensive bound on concatenated event output; the Playground applies its
// own output limits well below this.
const MAX_OUTPUT_CHARS = 256 * 1024;
// Bound upstream JSON before decoding it. JSON escaping can expand each output
// character to six bytes; the remainder leaves room for diagnostics/metadata.
const MAX_UPSTREAM_RESPONSE_BYTES = MAX_OUTPUT_CHARS * 6 + 64 * 1024;
const CACHE_TTL_SECONDS = 60 * 60;
const RATE_LIMIT_RUNS_PER_MINUTE = 10;

type LimitedBody =
  | { status: "ok"; text: string }
  | { status: "too-large" }
  | { status: "read-error" };

async function readBodyWithLimit(
  message: Pick<Request, "body" | "headers">,
  maxBytes: number,
): Promise<LimitedBody> {
  const contentLengthHeader = message.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { status: "too-large" };
    }
  }

  if (!message.body) {
    return { status: "ok", text: "" };
  }

  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { status: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { status: "read-error" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "ok", text: new TextDecoder().decode(bytes) };
}

interface GoSourceToken {
  kind: "identifier" | "string" | "symbol";
  value: string;
  hasEscape?: boolean;
}

function tokenizeGoSource(source: string): GoSourceToken[] {
  const tokens: GoSourceToken[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(source.length, index + 2);
      continue;
    }

    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }

    if (character === '"' || character === "`") {
      const quote = character;
      let value = "";
      let hasEscape = false;
      index += 1;

      while (index < source.length) {
        const next = source[index];
        if (next === quote) {
          index += 1;
          break;
        }
        if (quote === '"' && next === "\\") {
          hasEscape = true;
          value += next;
          index += 1;
          if (index < source.length) {
            value += source[index];
            index += 1;
          }
          continue;
        }
        value += next;
        index += 1;
      }

      tokens.push({ kind: "string", value, hasEscape });
      continue;
    }

    tokens.push({ kind: "symbol", value: character });
    index += 1;
  }

  return tokens;
}

function collectImportPathTokens(tokens: GoSourceToken[]): GoSourceToken[] {
  const importPaths: GoSourceToken[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind !== "identifier" || tokens[index].value !== "import") continue;

    let cursor = index + 1;
    if (tokens[cursor]?.value === "(") {
      cursor += 1;
      while (cursor < tokens.length && tokens[cursor].value !== ")") {
        if (tokens[cursor].kind === "string") importPaths.push(tokens[cursor]);
        cursor += 1;
      }
      index = cursor;
      continue;
    }

    if (tokens[cursor]?.kind === "string") {
      importPaths.push(tokens[cursor]);
      continue;
    }

    // Optional import alias: identifier, `_`, or `.` followed by the path.
    if (
      (tokens[cursor]?.kind === "identifier" || tokens[cursor]?.value === ".") &&
      tokens[cursor + 1]?.kind === "string"
    ) {
      importPaths.push(tokens[cursor + 1]);
    }
  }

  return importPaths;
}

/** Return a user-facing policy error, or null when source fits the pure v1 contract. */
export function validateGoLessonSource(source: string): string | null {
  // The Playground treats txtar separators as additional files. Reject them
  // before tokenization so v1 remains one editable main.go.
  if (/^-- [^\r\n]+ --[ \t]*\r?$/m.test(source)) {
    return "Go lessons support one main.go file; multi-file txtar input is not enabled";
  }

  const tokens = tokenizeGoSource(source);
  if (
    tokens[0]?.kind !== "identifier" ||
    tokens[0].value !== "package" ||
    tokens[1]?.kind !== "identifier" ||
    tokens[1].value !== "main"
  ) {
    return "Go lessons run a single 'package main' program";
  }

  for (const importPath of collectImportPathTokens(tokens)) {
    if (importPath.hasEscape) {
      return "Go lesson import paths cannot use escape sequences";
    }

    const firstSegment = importPath.value.split("/", 1)[0];
    if (importPath.value === "C" || firstSegment.includes(".")) {
      return `Go lessons support standard-library imports only; '${importPath.value}' is not allowed`;
    }
  }

  return null;
}

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
      : typeof body.Status === "number" && Number.isSafeInteger(body.Status) && body.Status >= 0
        ? body.Status
        : null;
  if (exitStatus === null) {
    return null;
  }
  if (body.IsTest != null && typeof body.IsTest !== "boolean") {
    return null;
  }
  if (
    body.TestsFailed != null &&
    (typeof body.TestsFailed !== "number" ||
      !Number.isSafeInteger(body.TestsFailed) ||
      body.TestsFailed < 0)
  ) {
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
    if (message == null) {
      continue;
    }
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
    : exitStatus !== 0
      ? {
          status: "runtime-error",
          output,
          exitCode: exitStatus,
          ...(vetErrors.trim() ? { vetErrors } : {}),
        }
      : vetErrors.trim()
        ? { status: "vet-error", output, vetErrors, exitCode: 0 }
        : { status: "success", output, exitCode: 0 };

  if (body.IsTest === true) {
    result.isTest = true;
  }
  if (typeof body.TestsFailed === "number") {
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
  const windowKey = `gp:rl:${userId}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const count = Number((await cache.get(windowKey)) ?? "0");
    if (!Number.isSafeInteger(count) || count < 0) {
      console.error("Go Playground rate-limit state was invalid");
      return "unavailable";
    }
    if (count >= RATE_LIMIT_RUNS_PER_MINUTE) {
      return "limited";
    }
    await cache.put(windowKey, String(count + 1), { expirationTtl: 120 });
    return "allowed";
  } catch {
    console.error("Go Playground rate-limit check failed");
    return "unavailable";
  }
}

async function readCachedResult(
  cache: KVNamespace | null,
  key: string,
): Promise<GoPlaygroundRunResult | null> {
  if (!cache) {
    return null;
  }
  try {
    return parseGoPlaygroundRunResult(await cache.get<unknown>(key, "json"));
  } catch {
    console.error("Go Playground cache read failed");
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
  } catch {
    console.error("Go Playground cache write failed");
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

  const requestBody = await readBodyWithLimit(c.req.raw, MAX_REQUEST_BYTES);
  if (requestBody.status === "too-large") {
    return c.json({ error: `request body exceeds ${MAX_REQUEST_BYTES} bytes` }, 413);
  }
  if (requestBody.status === "read-error") {
    return c.json({ error: "request body could not be read" }, 400);
  }

  let body: unknown;
  try {
    body = JSON.parse(requestBody.text);
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "JSON body must be an object" }, 400);
  }

  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== "source") {
    return c.json({ error: "'source' is the only supported field" }, 400);
  }

  const source = (body as Record<string, unknown>).source;
  if (typeof source !== "string" || source.trim().length === 0) {
    return c.json({ error: "'source' must be a non-empty string" }, 400);
  }

  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > MAX_SOURCE_BYTES) {
    return c.json({ error: `source exceeds ${MAX_SOURCE_BYTES} bytes` }, 413);
  }

  const sourcePolicyError = validateGoLessonSource(source);
  if (sourcePolicyError) {
    return c.json({ error: sourcePolicyError }, 400);
  }

  const cache = getCache(c.env);
  const rateLimitDecision = await checkRateLimit(cache, user.id);
  if (rateLimitDecision === "limited") {
    return c.json({ error: "rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Go Playground execution policy is unavailable" }, 502);
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

  const upstreamSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(UPSTREAM_COMPILE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      body: new URLSearchParams({ version: "2", body: source, withVet: "true" }).toString(),
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
      : c.json({ error: "the Go Playground service is unavailable" }, 502);
  }

  let result: GoPlaygroundRunResult | null = null;
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
        result = normalizeUpstreamCompileResponse(JSON.parse(upstreamBody.text));
      } catch {
        result = null;
      }
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
