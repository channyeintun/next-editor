import { readBodyWithLimit, type LimitedBody } from "../httpBody";
import { sanitizeUpstreamText } from "../upstreamText";

/**
 * The Worker's only way to talk to AthanLab (https://athanlab.com/docs).
 * AthanLab's CORS policy admits only its own site and its API terms keep keys
 * on servers, so every call from Studio is made here, with the caller's key in
 * the X-API-Key header and nowhere else: never in a URL, never in a log line,
 * never in a message handed back to the browser.
 *
 * Every URL is built from ATHANLAB_API_BASE plus ids that passed the patterns
 * below; the `Location` header, `audio.url`, and any other URL AthanLab sends
 * back are never fetched with a key.
 */

export const ATHANLAB_API_BASE = "https://api.athanlab.com/api/v1";
export const ATHANLAB_KEY_PATTERN = /^ak_live_[0-9a-fA-F]{32}$/;
export const ATHANLAB_JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
export const ATHANLAB_VOICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

// Per-phase limits on waiting for AthanLab's response headers.
export const SUBMIT_TIMEOUT_MS = 30_000;
export const POLL_TIMEOUT_MS = 15_000;
export const DOWNLOAD_HEADERS_TIMEOUT_MS = 30_000;
/** A streamed body (finished audio, a voice sample) errors after this long without a chunk. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
/** Key checks, voices, usage: interactive reads that answer at once or not at all. */
export const READ_TIMEOUT_MS = 15_000;

// The retry rule shared by submit, poll, and download (see retryPhase).
const MAX_TRANSIENT_FAILURES = 3;
const MIN_RETRY_WAIT_MS = 1_000;
const MAX_RETRY_WAIT_MS = 30_000;
// Statuses whose unreadable body (an HTML page from a proxy, or nothing) still
// says "try again": AthanLab's own errors always carry `retryable`.
const TRANSIENT_UNPARSED_STATUSES = new Set([500, 502, 503, 504, 524]);

// An error body is read only to quote it; AthanLab's envelopes are far below this.
const MAX_ERROR_BYTES = 4 * 1024;
const MAX_MESSAGE_CHARS = 200;
const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;
const REQUEST_ID_PATTERN = /^req_[0-9a-f]{24}$/;
const SCOPE_PATTERN = /^[a-z]{1,32}:[a-z]{1,32}$/;
// Anything shaped like an AthanLab key, whoever's it is.
const KEY_LIKE_PATTERN = /\bak_[a-z]{1,16}_[0-9A-Za-z]{8,}/g;

export interface AthanLabRequestInit {
  method: "GET" | "POST";
  /** Path under ATHANLAB_API_BASE, built only from validated ids. */
  path: string;
  accept: string;
  /** JSON request body, sent exactly as given. */
  body?: string;
  idempotencyKey?: string;
  timeoutMs: number;
}

export interface AthanLabFetched {
  response: Response;
  /**
   * Stops the timeout. Call it once a JSON body has been read, or as soon as
   * the headers are in when the body is streamed on under its own guard.
   */
  done(): void;
}

/** A GET for a JSON answer under READ_TIMEOUT_MS: key checks, voices, usage. */
export function readJsonGet(path: string): AthanLabRequestInit {
  return { method: "GET", path, accept: "application/json", timeoutMs: READ_TIMEOUT_MS };
}

/**
 * Send one request to AthanLab. Rejects when the network fails or no response
 * headers arrive within `timeoutMs`. Redirects are never followed: a 3xx comes
 * back as an ordinary failed response.
 */
export async function athanLabFetch(
  apiKey: string,
  init: AthanLabRequestInit,
): Promise<AthanLabFetched> {
  const headers: Record<string, string> = { Accept: init.accept, "X-API-Key": apiKey };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.idempotencyKey !== undefined) headers["Idempotency-Key"] = init.idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("AthanLab did not answer in time")),
    init.timeoutMs,
  );
  try {
    const response = await fetch(`${ATHANLAB_API_BASE}${init.path}`, {
      method: init.method,
      headers,
      body: init.body,
      redirect: "manual",
      signal: controller.signal,
    });
    return { response, done: () => clearTimeout(timer) };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

/** A JSON body read under `maxBytes`, or undefined when it is not JSON or too large. */
export async function readJsonBody(response: Response, maxBytes: number): Promise<unknown> {
  const body = await readBodyWithLimit(response, maxBytes);
  if (body.status !== "ok") {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  return parseJsonOrUndefined(body.text);
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export interface AthanLabErrorDetails {
  requiredScope?: string;
  activeJobs?: number;
  maxConcurrentJobs?: number;
  jobId?: string;
}

declare const upstreamCodeBrand: unique symbol;

/**
 * An error code AthanLab itself sent, which the routes relay to the page as it
 * came. Branded apart from plain strings so every code the routes write
 * themselves stays checked against AthanLabErrorCode
 * (src/studio/tts/athanlab/protocol.ts).
 */
export type AthanLabUpstreamCode = string & { readonly [upstreamCodeBrand]: true };

/** A well-formed AthanLab error code, or null. */
function upstreamCodeOf(code: unknown): AthanLabUpstreamCode | null {
  return typeof code === "string" && ERROR_CODE_PATTERN.test(code)
    ? (code as AthanLabUpstreamCode)
    : null;
}

export interface AthanLabError {
  status: number;
  /** AthanLab's machine-readable code, when it sent a well-formed one. */
  code: AthanLabUpstreamCode | null;
  /** Its message, safe to show and log: key redacted, flattened, bounded. */
  message: string | null;
  /** The body was AthanLab's JSON error envelope. */
  parsed: boolean;
  retryable: boolean;
  /** The Retry-After header, in whole seconds. */
  retryAfterSeconds: number | null;
  requestId: string | null;
  details: AthanLabErrorDetails;
}

/**
 * Make AthanLab text safe to hand back to the browser and to logs
 * (upstreamText.ts): the caller's key and anything else shaped like a key are
 * redacted, control characters are flattened, and the result is
 * length-bounded.
 */
export function sanitizeAthanLabText(
  text: string,
  apiKey: string,
  maxChars = MAX_MESSAGE_CHARS,
): string | null {
  return sanitizeUpstreamText(text, {
    secrets: [apiKey],
    secretPattern: KEY_LIKE_PATTERN,
    maxChars,
  });
}

/** The Retry-After header in whole seconds, or null when absent or not a number. */
export function retryAfterSecondsOf(response: Response): number | null {
  const header = response.headers.get("retry-after")?.trim();
  return header && /^\d{1,9}$/.test(header) ? Number(header) : null;
}

function nonNegativeIntegerOf(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

/**
 * Read a failed AthanLab response into its error envelope
 * (`{error: {type, code, message, retryable, request_id, details?}}`). An
 * unreadable body still yields its status and Retry-After; nothing in it is
 * trusted beyond these validated fields.
 */
export async function readAthanLabError(
  response: Response,
  apiKey: string,
): Promise<AthanLabError> {
  const result: AthanLabError = {
    status: response.status,
    code: null,
    message: null,
    parsed: false,
    retryable: false,
    retryAfterSeconds: retryAfterSecondsOf(response),
    requestId: null,
    details: {},
  };
  const headerRequestId = response.headers.get("x-request-id");
  if (headerRequestId && REQUEST_ID_PATTERN.test(headerRequestId)) {
    result.requestId = headerRequestId;
  }

  const payload = await readJsonBody(response, MAX_ERROR_BYTES);
  const envelope =
    typeof payload === "object" && payload !== null
      ? (payload as { error?: unknown }).error
      : undefined;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return result;
  }

  const {
    code,
    message,
    retryable,
    request_id: requestId,
    details,
  } = envelope as Record<string, unknown>;
  result.parsed = true;
  result.retryable = retryable === true;
  result.code = upstreamCodeOf(code);
  if (typeof message === "string") result.message = sanitizeAthanLabText(message, apiKey);
  if (typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId)) {
    result.requestId = requestId;
  }
  if (typeof details === "object" && details !== null) {
    const {
      required_scope: requiredScope,
      active_jobs: activeJobs,
      max_concurrent_jobs: maxConcurrentJobs,
      job_id: jobId,
    } = details as Record<string, unknown>;
    if (typeof requiredScope === "string" && SCOPE_PATTERN.test(requiredScope)) {
      result.details.requiredScope = requiredScope;
    }
    const active = nonNegativeIntegerOf(activeJobs);
    if (active !== undefined) result.details.activeJobs = active;
    const max = nonNegativeIntegerOf(maxConcurrentJobs);
    if (max !== undefined) result.details.maxConcurrentJobs = max;
    if (typeof jobId === "string" && ATHANLAB_JOB_ID_PATTERN.test(jobId)) {
      result.details.jobId = jobId;
    }
  }
  return result;
}

/**
 * Worth asking again: AthanLab said so (`retryable`), or a proxy in between
 * failed without AthanLab's envelope. HTTP 429 alone is not enough —
 * `key_budget_exceeded` is a 429 that no wait fixes.
 */
export function isTransientError(error: AthanLabError): boolean {
  return error.retryable || (!error.parsed && TRANSIENT_UNPARSED_STATUSES.has(error.status));
}

/**
 * A human-readable account of an AthanLab error, already sanitized. It does
 * not name AthanLab, so callers can prefix it or let the browser do so.
 */
export function describeAthanLabError(error: AthanLabError | null): string {
  if (!error) return "no response (the connection failed or timed out)";
  const message = error.message ?? `HTTP ${error.status}`;
  const { activeJobs, maxConcurrentJobs } = error.details;
  if (
    error.code === "concurrency_limit" &&
    activeJobs !== undefined &&
    maxConcurrentJobs !== undefined
  ) {
    return `${message} (${activeJobs} of ${maxConcurrentJobs} jobs running)`;
  }
  return message;
}

/** The subrequests one Worker invocation may still spend on AthanLab. */
export interface SubrequestBudget {
  used: number;
  readonly limit: number;
}

export interface RetryContext {
  apiKey: string;
  /** epoch ms after which no new wait may end. */
  deadline: number;
  budget: SubrequestBudget;
}

export type PhaseOutcome =
  | { kind: "ok"; response: Response; done(): void }
  /** A final answer for this phase, including 401 and `auth_blocked`. */
  | { kind: "rejected"; error: AthanLabError }
  /** Transient failures that could not be waited out. */
  | { kind: "unavailable"; error: AthanLabError | null; retryAfterSeconds: number }
  /** No subrequest left beyond `reserve`; nothing was sent. */
  | { kind: "out_of_budget" };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How one attempt at a phase ended. */
type AttemptResult<T> =
  | { kind: "ok"; value: T }
  /** Worth asking again; `error` is null when AthanLab never answered. */
  | { kind: "transient"; error: AthanLabError | null }
  /** A final answer for this phase, including 401 and `auth_blocked`. */
  | { kind: "rejected"; error: AthanLabError };

/**
 * Send one AthanLab request and sort its failure: a failed fetch or a
 * retryable error is transient, `auth_blocked` and every other error are
 * final. A failed response's error envelope is read here; an ok response is
 * handed back with its body unread and its timeout still running.
 */
async function fetchAttempt(
  apiKey: string,
  init: AthanLabRequestInit,
): Promise<AttemptResult<AthanLabFetched>> {
  let fetched: AthanLabFetched;
  try {
    fetched = await athanLabFetch(apiKey, init);
  } catch {
    return { kind: "transient", error: null };
  }
  if (fetched.response.ok) return { kind: "ok", value: fetched };

  let error: AthanLabError;
  try {
    error = await readAthanLabError(fetched.response, apiKey);
  } finally {
    fetched.done();
  }
  return error.code !== "auth_blocked" && isTransientError(error)
    ? { kind: "transient", error }
    : { kind: "rejected", error };
}

// Suggested wait when a single-attempt request fails without a Retry-After.
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * Send one AthanLab request without retrying: for the interactive routes (key
 * checks, voices, usage), where the person asking can simply ask again. A
 * transient failure comes back as "unavailable" with the wait AthanLab asked
 * for; `auth_blocked` comes back "rejected" so the caller can record it.
 */
export async function requestOnce(
  apiKey: string,
  init: AthanLabRequestInit,
): Promise<Exclude<PhaseOutcome, { kind: "out_of_budget" }>> {
  const attempt = await fetchAttempt(apiKey, init);
  if (attempt.kind === "ok") return { kind: "ok", ...attempt.value };
  if (attempt.kind === "rejected") return attempt;
  return {
    kind: "unavailable",
    error: attempt.error,
    retryAfterSeconds: Math.max(1, attempt.error?.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS),
  };
}

function retryWaitMs(error: AthanLabError | null, failures: number): number {
  if (error?.retryAfterSeconds != null) {
    return Math.max(MIN_RETRY_WAIT_MS, error.retryAfterSeconds * 1000);
  }
  return MIN_RETRY_WAIT_MS * 2 ** (failures - 1);
}

/**
 * Run a phase's attempts under the retry rule shared by submit, poll and
 * download. A transient failure is retried after `max(1 s, Retry-After)` — no
 * upper clamp on AthanLab's own number — or 1 s, 2 s, 4 s without one; the
 * third failure in a row ends the phase, and so does a wait that would pass
 * the deadline or exceed 30 s. Each attempt spends one subrequest, and
 * `reserve` of them are left for a later phase.
 */
async function retryPhase<T>(
  context: RetryContext,
  reserve: number,
  attempt: () => Promise<AttemptResult<T>>,
): Promise<{ kind: "ok"; value: T } | Exclude<PhaseOutcome, { kind: "ok" }>> {
  for (let failures = 1; ; failures++) {
    if (context.budget.used + reserve >= context.budget.limit) return { kind: "out_of_budget" };
    context.budget.used++;

    const result = await attempt();
    if (result.kind !== "transient") return result;

    const waitMs = retryWaitMs(result.error, failures);
    if (
      failures >= MAX_TRANSIENT_FAILURES ||
      waitMs > MAX_RETRY_WAIT_MS ||
      Date.now() + waitMs > context.deadline
    ) {
      return {
        kind: "unavailable",
        error: result.error,
        retryAfterSeconds: Math.ceil(waitMs / 1000),
      };
    }
    await sleep(waitMs);
  }
}

/**
 * Send one AthanLab request under the shared retry rule (retryPhase), handing
 * back an ok response at its headers. `auth_blocked` is never retried.
 */
export async function requestWithRetries(
  context: RetryContext,
  init: AthanLabRequestInit,
  reserve = 0,
): Promise<PhaseOutcome> {
  const outcome = await retryPhase(context, reserve, () => fetchAttempt(context.apiKey, init));
  return outcome.kind === "ok" ? { kind: "ok", ...outcome.value } : outcome;
}

export type JsonPhaseOutcome =
  | {
      kind: "ok";
      /** Headers only: the body has been read. */
      response: Response;
      /** Undefined when a body that arrived whole is not JSON or is too large. */
      payload: unknown;
    }
  | Exclude<PhaseOutcome, { kind: "ok" }>;

/**
 * requestWithRetries for submit and poll, with the JSON body read under
 * `maxBytes` as part of each attempt: a body that breaks off after the
 * headers (a timeout, an abort, a truncated stream) is a transient failure
 * like a failed fetch, and is asked for again under the same rule — safe,
 * since a submit repeats its idempotency key and a poll only reads. A body
 * that arrives whole but is too large or not JSON is final. The phase timeout
 * covers the body too.
 */
export async function requestJsonWithRetries(
  context: RetryContext,
  init: AthanLabRequestInit,
  reserve: number,
  maxBytes: number,
): Promise<JsonPhaseOutcome> {
  const outcome = await retryPhase(
    context,
    reserve,
    async (): Promise<AttemptResult<{ response: Response; payload: unknown }>> => {
      const attempt = await fetchAttempt(context.apiKey, init);
      if (attempt.kind !== "ok") return attempt;

      const { response } = attempt.value;
      let body: LimitedBody;
      try {
        body = await readBodyWithLimit(response, maxBytes);
      } finally {
        attempt.value.done();
      }
      if (body.status === "ok") {
        return { kind: "ok", value: { response, payload: parseJsonOrUndefined(body.text) } };
      }
      if (body.status === "too-large") {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "ok", value: { response, payload: undefined } };
      }
      // "read-error": transient, with no AthanLab error to quote.
      return { kind: "transient", error: null };
    },
  );
  return outcome.kind === "ok" ? { kind: "ok", ...outcome.value } : outcome;
}

export type SpeechJobStatus = "processing" | "succeeded" | "failed" | "cancelled";

export interface SpeechJob {
  id: string;
  status: SpeechJobStatus;
  /** Why a failed job failed; null otherwise. */
  error: { code: AthanLabUpstreamCode | null; message: string | null; retryable: boolean } | null;
}

const SPEECH_JOB_STATUSES = new Set<string>(["processing", "succeeded", "failed", "cancelled"]);

/**
 * The fields of a SpeechJob (a create response or a poll) this Worker acts
 * on, or null when the body is not a job with a well-formed id. Its `audio.url`
 * and every other URL are deliberately dropped.
 */
export function speechJobOf(payload: unknown, apiKey: string): SpeechJob | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { id, status, error } = payload as Record<string, unknown>;
  if (typeof id !== "string" || !ATHANLAB_JOB_ID_PATTERN.test(id)) return null;
  if (typeof status !== "string" || !SPEECH_JOB_STATUSES.has(status)) return null;

  let jobError: SpeechJob["error"] = null;
  if (typeof error === "object" && error !== null) {
    const { code, message, retryable } = error as Record<string, unknown>;
    jobError = {
      code: upstreamCodeOf(code),
      message: typeof message === "string" ? sanitizeAthanLabText(message, apiKey) : null,
      retryable: retryable === true,
    };
  }
  return { id, status: status as SpeechJobStatus, error: jobError };
}

/** The response's media type, lowercased, without parameters. */
export function mediaTypeOf(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

/** A declared Content-Length, or null when absent or malformed. */
export function contentLengthOf(response: Response): number | null {
  const header = response.headers.get("content-length")?.trim();
  return header && /^\d{1,15}$/.test(header) ? Number(header) : null;
}

export interface StreamGuardOptions {
  /** Error once more than this many bytes have passed, declared or not. */
  maxBytes: number;
  /** Error when no chunk arrives for this long. */
  idleTimeoutMs: number;
  /** The declared Content-Length: a body ending short of it, or running past it, errors. */
  expectedBytes: number | null;
}

/**
 * Pass a streamed body through unchanged while bounding it: its size, the gap
 * between chunks, and its agreement with a declared length. An empty body is
 * an error too. Erroring the stream aborts the response mid-transfer, so the
 * browser sees a failed download instead of a short file it would accept.
 */
export function guardStream(
  body: ReadableStream<Uint8Array>,
  options: StreamGuardOptions,
): ReadableStream<Uint8Array> {
  let received = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: (reason: string) => void = () => undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fail("stalled"), options.idleTimeoutMs);
  };

  const guard = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      fail = (reason) => {
        clearTimeout(timer);
        console.error("AthanLab audio stream failed", { reason, receivedBytes: received });
        try {
          controller.error(new Error(`AthanLab audio download ${reason}`));
        } catch {
          // Already closed or cancelled: nothing left to stop.
        }
      };
      arm();
    },
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (
        received > options.maxBytes ||
        (options.expectedBytes !== null && received > options.expectedBytes)
      ) {
        fail("was larger than expected");
        return;
      }
      arm();
      controller.enqueue(chunk);
    },
    flush() {
      clearTimeout(timer);
      if (received === 0) fail("was empty");
      else if (options.expectedBytes !== null && received < options.expectedBytes) {
        fail("ended early");
      }
    },
    // The browser went away: stop watching for a stall nobody will read.
    cancel() {
      clearTimeout(timer);
    },
  });
  return body.pipeThrough(guard);
}
