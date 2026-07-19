import { Hono } from "hono";
import type { Env } from "../env";
import { getCurrentUser } from "../auth/session";
import { getCache } from "../cache";
import { readBodyWithLimit } from "../httpBody";
import {
  parseKotlinPlaygroundRunResult,
  type KotlinPlaygroundFile,
  type KotlinPlaygroundRunResult,
} from "../../../src/runtime/kotlinPlayground/types";

// Mounted at /api/kotlin-playground in worker/index.ts. First-party proxy in
// front of the official Kotlin Playground compiler API (api.kotlinlang.org,
// the same service JetBrains' embeddable kotlin-playground widget uses) for
// pure Kotlin lessons, mirroring routes/goPlayground.ts. The browser never
// calls the upstream service directly: this route owns the kill switch,
// authentication, file/program-size checks, per-user rate limiting,
// content-hash caching, the unique user agent, the upstream timeout, and
// normalization of the upstream response into the app's
// KotlinPlaygroundRunResult contract.
//
// Privacy invariant: user sources, filenames, program output, and diagnostics
// must never be logged — telemetry is aggregate fields only (see logRun
// below). Nothing application-specific (cookies, tokens, user identity) is
// sent upstream.

// The compiler version is pinned in the URL and folded into the cache-key
// prefix so a version bump can never serve results produced by a different
// compiler. 2.4.10 is upstream's latestStable (GET api.kotlinlang.org/versions).
const UPSTREAM_API_VERSION = "2.4.10";
const UPSTREAM_RUN_URL = `https://api.kotlinlang.org/api/${UPSTREAM_API_VERSION}/compiler/run`;
// JVM target: lessons are console programs. The js/wasm conf types have no
// console output model that fits the runner dock.
const UPSTREAM_CONF_TYPE = "java";
// Identifies Next Editor traffic to the upstream service, matching the Go
// route's third-party client etiquette.
const UPSTREAM_USER_AGENT = "NextEditor-KotlinPlayground/1.0 (+https://nexteditor.dev)";
// Shorter than the application request ceiling so a hung upstream surfaces as
// a bounded 504 instead of an opaque Worker timeout. The upstream itself
// kills programs after ~10s of execution, well inside this bound.
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_KT_FILES = 20;
const MAX_FILE_PATH_BYTES = 200;
const MAX_SOURCE_BYTES = 64 * 1024;
// JSON escaping can expand one source byte to six bytes (for example, a
// control character encoded as a \uXXXX sequence). Leave bounded room for the structured
// file paths and object syntax while allowing every valid serialized program.
const MAX_REQUEST_BYTES =
  MAX_SOURCE_BYTES * 6 + MAX_KT_FILES * (MAX_FILE_PATH_BYTES * 6 + 64) + 1024;
// Defensive bound on normalized program output; the Playground applies its
// own output limits well below this.
const MAX_OUTPUT_CHARS = 256 * 1024;
// Bound upstream JSON before decoding it. JSON escaping can expand each output
// character to six bytes; the remainder leaves room for diagnostics/metadata.
const MAX_UPSTREAM_RESPONSE_BYTES = MAX_OUTPUT_CHARS * 6 + 64 * 1024;
const MAX_DIAGNOSTIC_CHARS = 16 * 1024;
const MAX_EXCEPTION_CHARS = 16 * 1024;
const MAX_STACK_FRAMES = 20;
const MAX_CAUSE_DEPTH = 4;
const CACHE_TTL_SECONDS = 60 * 60;
const RATE_LIMIT_RUNS_PER_MINUTE = 10;

const KT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.kt$/;

function validateKotlinLessonFilePath(filePath: string): string | null {
  if (new TextEncoder().encode(filePath).byteLength > MAX_FILE_PATH_BYTES) {
    return `Kotlin file paths cannot exceed ${MAX_FILE_PATH_BYTES} bytes`;
  }
  if (!KT_FILE_NAME.test(filePath)) {
    return "Kotlin lessons support top-level .kt files with simple ASCII names only";
  }
  return null;
}

/** Deterministic order: Main.kt first, then lexicographic. Shared by the upstream payload and cache key. */
function sortKotlinLessonFiles(files: readonly KotlinPlaygroundFile[]): KotlinPlaygroundFile[] {
  return [...files].sort((left, right) => {
    if (left.path === "Main.kt") return right.path === "Main.kt" ? 0 : -1;
    if (right.path === "Main.kt") return 1;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

type KotlinLessonRequestValidation =
  | {
      ok: true;
      files: KotlinPlaygroundFile[];
      sourceBytes: number;
    }
  | { ok: false; status: 400 | 413; error: string };

async function validateKotlinLessonRequest(
  request: Request,
): Promise<KotlinLessonRequestValidation> {
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
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "'files' must contain at least one Kotlin source file",
    };
  }
  if (rawFiles.length > MAX_KT_FILES) {
    return {
      ok: false,
      status: 400,
      error: `Kotlin lessons support at most ${MAX_KT_FILES} files`,
    };
  }

  const files: KotlinPlaygroundFile[] = [];
  const seenPaths = new Set<string>();
  let sourceBytes = 0;
  for (const [index, rawFile] of rawFiles.entries()) {
    if (typeof rawFile !== "object" || rawFile === null || Array.isArray(rawFile)) {
      return { ok: false, status: 400, error: `files[${index}] must be an object` };
    }

    const fileRecord = rawFile as Record<string, unknown>;
    const fileKeys = Object.keys(fileRecord);
    if (fileKeys.length !== 2 || !fileKeys.includes("path") || !fileKeys.includes("content")) {
      return {
        ok: false,
        status: 400,
        error: `files[${index}] must contain only 'path' and 'content'`,
      };
    }
    if (typeof fileRecord.path !== "string") {
      return { ok: false, status: 400, error: `files[${index}].path must be a string` };
    }
    if (typeof fileRecord.content !== "string") {
      return { ok: false, status: 400, error: `files[${index}].content must be a string` };
    }

    const pathError = validateKotlinLessonFilePath(fileRecord.path);
    if (pathError) {
      return { ok: false, status: 400, error: pathError };
    }
    if (seenPaths.has(fileRecord.path)) {
      return { ok: false, status: 400, error: "Kotlin lesson file paths must be unique" };
    }

    sourceBytes += new TextEncoder().encode(fileRecord.content).byteLength;
    seenPaths.add(fileRecord.path);
    files.push({ path: fileRecord.path, content: fileRecord.content });
  }

  if (sourceBytes > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Kotlin program exceeds ${MAX_SOURCE_BYTES} bytes`,
    };
  }

  return { ok: true, files: sortKotlinLessonFiles(files), sourceBytes };
}

interface KotlinStreamSegment {
  stream: "out" | "err";
  text: string;
}

// Upstream wraps interleaved program output in <outStream>/<errStream>
// markers. Any text between marker blocks (never observed, but not
// contractually excluded) is preserved as stdout so output can't silently
// vanish.
function parseUpstreamOutputText(text: string): KotlinStreamSegment[] {
  const segments: KotlinStreamSegment[] = [];
  const marker = /<(out|err)Stream>([\s\S]*?)<\/\1Stream>/g;
  let lastIndex = 0;

  for (const match of text.matchAll(marker)) {
    if (match.index > lastIndex) {
      segments.push({ stream: "out", text: text.slice(lastIndex, match.index) });
    }
    segments.push({ stream: match[1] === "err" ? "err" : "out", text: match[2] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ stream: "out", text: text.slice(lastIndex) });
  }

  return segments;
}

// The upstream sandbox kills long-running programs itself (~10s) and reports
// it as a plain stderr line with HTTP 200. Promote that marker to a
// runtime-error so the console doesn't render a successful exit after it.
const UPSTREAM_KILLED_MESSAGE = "Evaluation stopped while it's taking too long";
const UPSTREAM_KILLED_PATTERN = /^Evaluation stopped while it.{0,2}s taking too long\W{0,2}$/u;

interface UpstreamDiagnosticBuckets {
  compileErrors: string;
  warnings: string;
}

function formatUpstreamDiagnostics(value: unknown): UpstreamDiagnosticBuckets | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const compileErrorLines: string[] = [];
  const warningLines: string[] = [];

  for (const [fileName, rawDiagnostics] of Object.entries(value)) {
    if (!Array.isArray(rawDiagnostics)) {
      return null;
    }
    for (const rawDiagnostic of rawDiagnostics) {
      if (typeof rawDiagnostic !== "object" || rawDiagnostic === null) {
        return null;
      }
      const diagnostic = rawDiagnostic as Record<string, unknown>;
      if (typeof diagnostic.message !== "string" || typeof diagnostic.severity !== "string") {
        return null;
      }

      // Positions are 0-based {line, ch} pairs; render 1-based like kotlinc.
      let position = "";
      const interval = diagnostic.interval;
      if (interval != null) {
        if (typeof interval !== "object") {
          return null;
        }
        const start = (interval as Record<string, unknown>).start;
        if (typeof start !== "object" || start === null) {
          return null;
        }
        const line = (start as Record<string, unknown>).line;
        const ch = (start as Record<string, unknown>).ch;
        if (
          typeof line !== "number" ||
          !Number.isSafeInteger(line) ||
          line < 0 ||
          typeof ch !== "number" ||
          !Number.isSafeInteger(ch) ||
          ch < 0
        ) {
          return null;
        }
        position = `:${line + 1}:${ch + 1}`;
      }

      const isError = diagnostic.severity === "ERROR";
      const label = isError ? "error" : "warning";
      (isError ? compileErrorLines : warningLines).push(
        `${fileName}${position}: ${label}: ${diagnostic.message}`,
      );
    }
  }

  const truncate = (lines: string[]) => {
    const joined = lines.join("\n");
    return joined.length > MAX_DIAGNOSTIC_CHARS
      ? `${joined.slice(0, MAX_DIAGNOSTIC_CHARS)}\n[diagnostics truncated]`
      : joined;
  };

  return { compileErrors: truncate(compileErrorLines), warnings: truncate(warningLines) };
}

function formatUpstreamException(value: unknown, depth = 0): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  // A deeper chain is legitimate program behavior, not an invalid payload —
  // stop rendering instead of rejecting.
  if (depth >= MAX_CAUSE_DEPTH) {
    return "[cause chain truncated]";
  }

  const exception = value as Record<string, unknown>;
  if (typeof exception.fullName !== "string") {
    return null;
  }
  const message = exception.message;
  if (message != null && typeof message !== "string") {
    return null;
  }

  const lines = [`${exception.fullName}${message ? `: ${message}` : ""}`];

  const stackTrace = exception.stackTrace == null ? [] : exception.stackTrace;
  if (!Array.isArray(stackTrace)) {
    return null;
  }
  for (const rawFrame of stackTrace.slice(0, MAX_STACK_FRAMES)) {
    if (typeof rawFrame !== "object" || rawFrame === null) {
      return null;
    }
    const frame = rawFrame as Record<string, unknown>;
    if (typeof frame.className !== "string" || typeof frame.methodName !== "string") {
      return null;
    }
    // The first frame without a file name marks the reflection/launcher glue
    // below user code — everything after it is noise for a lesson console.
    if (typeof frame.fileName !== "string") {
      break;
    }
    const lineNumber =
      typeof frame.lineNumber === "number" && Number.isSafeInteger(frame.lineNumber)
        ? frame.lineNumber
        : null;
    if (lineNumber === null) {
      return null;
    }
    lines.push(`\tat ${frame.className}.${frame.methodName}(${frame.fileName}:${lineNumber})`);
  }

  if (exception.cause != null) {
    const cause = formatUpstreamException(exception.cause, depth + 1);
    if (cause === null) {
      return null;
    }
    lines.push(`Caused by: ${cause}`);
  }

  const joined = lines.join("\n");
  return joined.length > MAX_EXCEPTION_CHARS
    ? `${joined.slice(0, MAX_EXCEPTION_CHARS)}\n[exception truncated]`
    : joined;
}

/**
 * Normalize the upstream compiler response. Only the fields verified against
 * the live service are read (errors, exception, text); unknown fields (like
 * jvmByteCode) are ignored. Any field with an unexpected type makes the whole
 * payload invalid — the caller turns that into a 502, never a successful
 * empty run.
 */
export function normalizeUpstreamRunResponse(payload: unknown): KotlinPlaygroundRunResult | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const body = payload as Record<string, unknown>;

  const diagnostics = formatUpstreamDiagnostics(body.errors ?? {});
  if (diagnostics === null) {
    return null;
  }

  const rawText = body.text == null ? "" : body.text;
  if (typeof rawText !== "string") {
    return null;
  }
  let segments = parseUpstreamOutputText(rawText);

  let exception: string | null = null;
  if (body.exception != null) {
    exception = formatUpstreamException(body.exception);
    if (exception === null) {
      return null;
    }
  }

  // The sandbox's own kill notice arrives as stderr text on an otherwise
  // clean payload; surface it as the failure instead of trailing output.
  if (!diagnostics.compileErrors && exception === null) {
    const killed = segments.some(
      (segment) => segment.stream === "err" && UPSTREAM_KILLED_PATTERN.test(segment.text.trim()),
    );
    if (killed) {
      segments = segments.filter(
        (segment) =>
          !(segment.stream === "err" && UPSTREAM_KILLED_PATTERN.test(segment.text.trim())),
      );
      exception = UPSTREAM_KILLED_MESSAGE;
    }
  }

  let output = segments.map((segment) => segment.text).join("");
  if (output.length > MAX_OUTPUT_CHARS) {
    output = `${output.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;
  }

  const result: KotlinPlaygroundRunResult = diagnostics.compileErrors
    ? { status: "compile-error", output, compileErrors: diagnostics.compileErrors }
    : exception !== null
      ? { status: "runtime-error", output, exception }
      : { status: "success", output };

  if (diagnostics.warnings) {
    result.warnings = diagnostics.warnings;
  }

  return result;
}

// Content-addressed cache key. The pinned compiler version and conf type are
// folded into the prefix so an upstream retarget can never serve results
// produced under a different compiler.
async function cacheKeyForFiles(files: readonly KotlinPlaygroundFile[]): Promise<string> {
  const serialized = JSON.stringify(files.map((file) => [file.path, file.content]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `kp:${UPSTREAM_API_VERSION}:${UPSTREAM_CONF_TYPE}:${hex}`;
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
  const windowKey = `kp:rl:${userId}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const count = Number((await cache.get(windowKey)) ?? "0");
    if (!Number.isSafeInteger(count) || count < 0) {
      console.error("Kotlin Playground rate-limit state was invalid");
      return "unavailable";
    }
    if (count >= RATE_LIMIT_RUNS_PER_MINUTE) {
      return "limited";
    }
    await cache.put(windowKey, String(count + 1), { expirationTtl: 120 });
    return "allowed";
  } catch {
    console.error("Kotlin Playground rate-limit check failed");
    return "unavailable";
  }
}

async function readCachedResult(
  cache: KVNamespace | null,
  key: string,
): Promise<KotlinPlaygroundRunResult | null> {
  if (!cache) {
    return null;
  }
  try {
    return parseKotlinPlaygroundRunResult(await cache.get<unknown>(key, "json"));
  } catch {
    console.error("Kotlin Playground cache read failed");
    return null;
  }
}

async function writeCachedResult(
  cache: KVNamespace | null,
  key: string,
  result: KotlinPlaygroundRunResult,
): Promise<void> {
  if (!cache) {
    return;
  }
  try {
    await cache.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    console.error("Kotlin Playground cache write failed");
  }
}

// Aggregate telemetry only — never sources, filenames, output, or diagnostics text.
function logRun(entry: {
  outcome: KotlinPlaygroundRunResult["status"] | "upstream-error" | "upstream-timeout";
  sourceBytes: number;
  cacheHit: boolean;
  durationMs: number;
}): void {
  console.log("kotlin-playground-run", entry);
}

export const kotlinPlaygroundRoute = new Hono<{ Bindings: Env }>();

kotlinPlaygroundRoute.post("/run", async (c) => {
  // Kill switch fails closed unless explicitly enabled. Editing and recorded
  // playback never touch this route.
  if (c.env.KOTLIN_PLAYGROUND_ENABLED !== "true") {
    return c.json({ error: "Kotlin Playground execution is disabled" }, 503);
  }

  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const request = await validateKotlinLessonRequest(c.req.raw);
  if (!request.ok) {
    return request.status === 413
      ? c.json({ error: request.error }, 413)
      : c.json({ error: request.error }, 400);
  }
  const { files, sourceBytes } = request;

  const cache = getCache(c.env);
  const rateLimitDecision = await checkRateLimit(cache, user.id);
  if (rateLimitDecision === "limited") {
    return c.json({ error: "rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Kotlin Playground execution policy is unavailable" }, 502);
  }

  const startedAt = Date.now();
  const cacheKey = await cacheKeyForFiles(files);
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
    upstreamResponse = await fetch(UPSTREAM_RUN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      body: JSON.stringify({
        args: "",
        files: files.map((file) => ({ name: file.path, text: file.content, publicId: "" })),
        confType: UPSTREAM_CONF_TYPE,
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
      : c.json({ error: "the Kotlin Playground service is unavailable" }, 502);
  }

  let result: KotlinPlaygroundRunResult | null = null;
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
        result = normalizeUpstreamRunResponse(JSON.parse(upstreamBody.text));
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
    return c.json({ error: "the Kotlin Playground service returned an unexpected response" }, 502);
  }

  // Only deterministic outcomes are cached, mirroring the Go route: success
  // and compile-error re-serve; runtime errors always re-run.
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
