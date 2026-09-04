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
  writeCachedValue,
} from "../playgroundProxy";
import {
  type GoPlaygroundFormatResult,
  parseGoPlaygroundRunResult,
  type GoPlaygroundFile,
  type GoPlaygroundRunResult,
} from "../../../src/runtime/goPlayground/types";

// Mounted at /api/go-playground in worker/index.ts. First-party proxy in
// front of the official Go Playground compile and format APIs for pure Go lessons
// (docs/go-lessons-selective-runtime-plan.md §7.2). The browser never calls
// the upstream service directly: this route owns the kill switch,
// authentication, file/program-size checks, per-user rate limiting, content-hash
// caching, the unique user agent, the upstream timeout, and normalization of
// the upstream response into the app's GoPlaygroundRunResult contract.
//
// Privacy invariant: user sources, filenames, program output, and diagnostics must never
// be logged — telemetry is aggregate fields only (see logRun below). Nothing
// application-specific (cookies, tokens, user identity) is sent upstream.

const UPSTREAM_COMPILE_URL = "https://play.golang.org/compile";
const UPSTREAM_FORMAT_URL = "https://play.golang.org/fmt";
// Identifies Next Editor traffic as the Go project asks of third-party
// clients. Confirm this string with the Playground maintainers before public
// production rollout (plan §8 Phase 0).
const UPSTREAM_USER_AGENT = "NextEditor-GoPlayground/1.0 (+https://nexteditor.dev)";
// Shorter than the application request ceiling so a hung upstream surfaces as
// a bounded 504 instead of an opaque Worker timeout.
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_GO_FILES = 20;
const MAX_FILE_PATH_BYTES = 200;
const MAX_SOURCE_BYTES = 64 * 1024;
// JSON escaping can expand one source byte to six bytes (for example, a
// control character encoded as \u0000). Leave bounded room for the structured
// file paths and object syntax while allowing every valid serialized program.
const MAX_REQUEST_BYTES =
  MAX_SOURCE_BYTES * 6 + MAX_GO_FILES * (MAX_FILE_PATH_BYTES * 6 + 64) + 1024;
// Defensive bound on concatenated event output; the Playground applies its
// own output limits well below this.
const MAX_OUTPUT_CHARS = 256 * 1024;
// Bound upstream JSON before decoding it. JSON escaping can expand each output
// character to six bytes; the remainder leaves room for diagnostics/metadata.
const MAX_UPSTREAM_RESPONSE_BYTES = MAX_OUTPUT_CHARS * 6 + 64 * 1024;
const MAX_UPSTREAM_FORMAT_RESPONSE_BYTES = MAX_SOURCE_BYTES * 6 + 64 * 1024;
const MAX_FORMAT_ERROR_CHARS = 16 * 1024;
const CACHE_TTL_SECONDS = 60 * 60;
const RATE_LIMIT_RUNS_PER_MINUTE = 10;
const RATE_LIMIT_FORMATS_PER_MINUTE = 20;

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

/** Return a user-facing policy error, or null when one file fits the pure contract. */
export function validateGoLessonSource(source: string): string | null {
  const tokens = tokenizeGoSource(source);
  if (
    tokens[0]?.kind !== "identifier" ||
    tokens[0].value !== "package" ||
    tokens[1]?.kind !== "identifier" ||
    tokens[1].value !== "main"
  ) {
    return "Every Go lesson file must use 'package main'";
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

const TXTAR_MARKER_LINE = /^-- [^\r\n]+ --[ \t]*\r?$/m;
const GO_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.go$/;

function validateGoLessonFilePath(filePath: string): string | null {
  if (new TextEncoder().encode(filePath).byteLength > MAX_FILE_PATH_BYTES) {
    return `Go file paths cannot exceed ${MAX_FILE_PATH_BYTES} bytes`;
  }
  if (!GO_FILE_NAME.test(filePath)) {
    return "Go lessons support top-level .go files with simple ASCII names only";
  }
  if (filePath.endsWith("_test.go")) {
    return "Go test files are not enabled for lessons yet";
  }
  return null;
}

/** Serialize validated lesson files into the txtar body understood by the Playground. */
export function serializeGoLessonFiles(files: readonly GoPlaygroundFile[]): string {
  const sortedFiles = [...files].sort((left, right) => {
    if (left.path === "main.go") return right.path === "main.go" ? 0 : -1;
    if (right.path === "main.go") return 1;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });

  return sortedFiles
    .map(({ path, content }) => `-- ${path} --\n${content}${content.endsWith("\n") ? "" : "\n"}`)
    .join("");
}

type GoLessonRequestValidation =
  | {
      ok: true;
      files: GoPlaygroundFile[];
      source: string;
      sourceBytes: number;
    }
  | { ok: false; status: 400 | 413; error: string };

async function validateGoLessonRequest(request: Request): Promise<GoLessonRequestValidation> {
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
      error: "'files' must contain at least one Go source file",
    };
  }
  if (rawFiles.length > MAX_GO_FILES) {
    return {
      ok: false,
      status: 400,
      error: `Go lessons support at most ${MAX_GO_FILES} files`,
    };
  }

  const files: GoPlaygroundFile[] = [];
  const seenPaths = new Set<string>();
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

    const pathError = validateGoLessonFilePath(fileRecord.path);
    if (pathError) {
      return { ok: false, status: 400, error: pathError };
    }
    if (seenPaths.has(fileRecord.path)) {
      return { ok: false, status: 400, error: "Go lesson file paths must be unique" };
    }
    if (TXTAR_MARKER_LINE.test(fileRecord.content)) {
      return {
        ok: false,
        status: 400,
        error: `${fileRecord.path} contains a reserved txtar marker line`,
      };
    }

    const sourcePolicyError = validateGoLessonSource(fileRecord.content);
    if (sourcePolicyError) {
      return { ok: false, status: 400, error: `${fileRecord.path}: ${sourcePolicyError}` };
    }

    seenPaths.add(fileRecord.path);
    files.push({ path: fileRecord.path, content: fileRecord.content });
  }

  const source = serializeGoLessonFiles(files);
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `serialized Go program exceeds ${MAX_SOURCE_BYTES} bytes`,
    };
  }

  return { ok: true, files, source, sourceBytes };
}

const TXTAR_FILE_HEADER = /^-- ([^\r\n]+) --\r?\n/gm;

function parseFormattedGoLessonFiles(
  source: string,
  submittedFiles: readonly GoPlaygroundFile[],
): GoPlaygroundFile[] | null {
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    return null;
  }

  const headers: Array<{ index: number; contentStart: number; path: string }> = [];
  for (const match of source.matchAll(TXTAR_FILE_HEADER)) {
    if (match.index === undefined) {
      return null;
    }
    headers.push({
      index: match.index,
      contentStart: match.index + match[0].length,
      path: match[1],
    });
  }

  const expectedFiles = [...submittedFiles].sort((left, right) => {
    if (left.path === "main.go") return right.path === "main.go" ? 0 : -1;
    if (right.path === "main.go") return 1;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  if (
    headers.length !== expectedFiles.length ||
    headers[0]?.index !== 0 ||
    headers.some((header, index) => header.path !== expectedFiles[index]?.path)
  ) {
    return null;
  }

  const files: GoPlaygroundFile[] = [];
  for (const [index, header] of headers.entries()) {
    const content = source.slice(header.contentStart, headers[index + 1]?.index ?? source.length);
    if (TXTAR_MARKER_LINE.test(content) || validateGoLessonSource(content) !== null) {
      return null;
    }
    files.push({ path: header.path, content });
  }

  // Reject upstream additions, omissions, trailing data, or a changed archive
  // representation before any returned source can reach the workspace.
  return serializeGoLessonFiles(files) === source ? files : null;
}

export function normalizeUpstreamFormatResponse(
  payload: unknown,
  submittedFiles: readonly GoPlaygroundFile[],
):
  | { kind: "result"; result: GoPlaygroundFormatResult }
  | { kind: "source-error"; error: string }
  | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const body = payload as Record<string, unknown>;
  if (typeof body.Body !== "string" || typeof body.Error !== "string") {
    return null;
  }

  if (body.Error.trim()) {
    if (body.Body !== "" || body.Error.length > MAX_FORMAT_ERROR_CHARS) {
      return null;
    }
    return { kind: "source-error", error: body.Error };
  }

  const files = parseFormattedGoLessonFiles(body.Body, submittedFiles);
  return files ? { kind: "result", result: { files } } : null;
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
  output = truncateOutput(output, MAX_OUTPUT_CHARS);

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
const CACHE_KEY_PREFIX = "gp:v2-vet";
// Named once so the rate-limit and cache diagnostics this route emits stay
// distinguishable from the sibling routes' in the Worker log.
const LOG_LABEL = "Go Playground";

// Aggregate telemetry only — never sources, filenames, output, or diagnostics text.
function logRun(entry: {
  outcome: GoPlaygroundRunResult["status"] | "upstream-error" | "upstream-timeout";
  sourceBytes: number;
  cacheHit: boolean;
  durationMs: number;
}): void {
  console.log("go-playground-run", entry);
}

function logFormat(entry: {
  outcome: "success" | "source-error" | "upstream-error" | "upstream-timeout";
  sourceBytes: number;
  durationMs: number;
}): void {
  console.log("go-playground-format", entry);
}

export const goPlaygroundRoute = new Hono<{ Bindings: Env }>();

goPlaygroundRoute.post("/run", async (c) => {
  // Shared Go-tool kill switch fails closed unless explicitly enabled.
  // Editing and recorded playback never touch either live route.
  if (c.env.GO_PLAYGROUND_ENABLED !== "true") {
    return c.json({ error: "Go Playground execution is disabled" }, 503);
  }

  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const request = await validateGoLessonRequest(c.req.raw);
  if (!request.ok) {
    return request.status === 413
      ? c.json({ error: request.error }, 413)
      : c.json({ error: request.error }, 400);
  }
  const { source, sourceBytes } = request;

  const cache = getCache(c.env);
  const startedAt = Date.now();

  // The cache is consulted before the rate limit, deliberately. The ceiling
  // exists to protect the upstream, and a cache hit never reaches it — a
  // learner re-running unchanged sources while reading the output would
  // otherwise spend the whole minute's budget on requests that cost the
  // upstream nothing, and be refused on the first run that needed compiling.
  const cacheKey = await contentCacheKey(CACHE_KEY_PREFIX, source);
  const cachedResult = await readCachedValue(
    cache,
    cacheKey,
    parseGoPlaygroundRunResult,
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

  const rateLimitDecision = await checkPlaygroundRateLimit(cache, {
    userId: user.id,
    keyPrefix: "gp:rl",
    limit: RATE_LIMIT_RUNS_PER_MINUTE,
    label: LOG_LABEL,
  });
  if (rateLimitDecision === "limited") {
    return c.json({ error: "rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Go Playground execution policy is unavailable" }, 502);
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

goPlaygroundRoute.post("/format", async (c) => {
  if (c.env.GO_PLAYGROUND_ENABLED !== "true") {
    return c.json({ error: "Go Playground tools are disabled" }, 503);
  }

  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const request = await validateGoLessonRequest(c.req.raw);
  if (!request.ok) {
    return request.status === 413
      ? c.json({ error: request.error }, 413)
      : c.json({ error: request.error }, 400);
  }

  const cache = getCache(c.env);
  const rateLimitDecision = await checkPlaygroundRateLimit(cache, {
    userId: user.id,
    keyPrefix: "gp:fmt:rl",
    limit: RATE_LIMIT_FORMATS_PER_MINUTE,
    label: LOG_LABEL,
  });
  if (rateLimitDecision === "limited") {
    return c.json({ error: "format rate limit exceeded; retry in a minute" }, 429);
  }
  if (rateLimitDecision === "unavailable") {
    return c.json({ error: "Go Playground formatting policy is unavailable" }, 502);
  }

  const startedAt = Date.now();
  const upstreamSignal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(UPSTREAM_FORMAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      // Deliberately omit `imports`: this is canonical gofmt, not goimports,
      // whose upstream implementation cannot resolve symbols in sibling files.
      body: new URLSearchParams({ body: request.source }).toString(),
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
      : c.json({ error: "the Go Playground formatter is unavailable" }, 502);
  }

  let normalized: ReturnType<typeof normalizeUpstreamFormatResponse> = null;
  if (upstreamResponse.ok) {
    const upstreamBody = await readBodyWithLimit(
      upstreamResponse,
      MAX_UPSTREAM_FORMAT_RESPONSE_BYTES,
    );
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
        normalized = normalizeUpstreamFormatResponse(JSON.parse(upstreamBody.text), request.files);
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
    return c.json({ error: "the Go Playground formatter returned an unexpected response" }, 502);
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
