import type { Context } from "hono";
import { checkRateLimit } from "../rateLimit";
import {
  ATHANLAB_RETRY_LATER,
  type AthanLabErrorCode,
  type AthanLabRetryLaterCode,
} from "../../../src/studio/tts/athanlab/protocol";
import { describeAthanLabError, type AthanLabError, type AthanLabUpstreamCode } from "./client";

// The JSON answers every AthanLab route gives the page (`{error, code?,
// retryAfterSeconds?}`), the one AthanLab line that reaches the logs, and the
// per-user rate-limit charge whose refusal is one of those answers.

// A per-user Rate Limiting period is 60 s.
const RATE_LIMIT_RETRY_SECONDS = 60;
const STILL_PROCESSING_RETRY_SECONDS = 5;

const NOT_CONFIGURED = "AthanLab narration is not configured on this server";
const KEY_CHECKS_PAUSED = "AthanLab key checks are paused for a few minutes — try again soon";
export const TEMPORARILY_UNAVAILABLE =
  "AthanLab narration is temporarily unavailable — try again soon";

type ErrorStatus = 400 | 409 | 413 | 429 | 502 | 503;

/** A code the page reads: one of the Worker's own, or AthanLab's as it came. */
export type ErrorCode = AthanLabErrorCode | AthanLabUpstreamCode;

/** Every JSON error here: `{error, code?, retryAfterSeconds?}`. */
export function failure(
  c: Context,
  status: ErrorStatus,
  error: string,
  code?: ErrorCode | null,
  retryAfterSeconds?: number,
) {
  const body: { error: string; code?: string; retryAfterSeconds?: number } = { error };
  if (code) body.code = code;
  if (retryAfterSeconds !== undefined) body.retryAfterSeconds = retryAfterSeconds;
  return c.json(body, status);
}

/** A "same request, ask again later" answer, at the status the page retries it with. */
export function retryLater(
  c: Context,
  code: AthanLabRetryLaterCode,
  error: string,
  retryAfterSeconds: number,
) {
  return failure(c, ATHANLAB_RETRY_LATER[code].status, error, code, retryAfterSeconds);
}

export function notConfigured(c: Context) {
  return failure(c, 503, NOT_CONFIGURED, "not_configured");
}

export function authBlocked(c: Context, blockedUntil: number) {
  const seconds = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
  const minutes = Math.ceil(seconds / 60);
  return failure(
    c,
    503,
    `AthanLab is temporarily refusing requests from Next Editor — try again in ${minutes} min`,
    "auth_blocked",
    seconds,
  );
}

export function keyChecksPaused(c: Context) {
  return failure(c, 503, KEY_CHECKS_PAUSED, "key_checks_paused");
}

export function stillProcessing(c: Context) {
  return retryLater(
    c,
    "still_processing",
    "AthanLab is still generating this dialog",
    STILL_PROCESSING_RETRY_SECONDS,
  );
}

export function unavailable(c: Context, error: AthanLabError | null, retryAfterSeconds: number) {
  return failure(
    c,
    503,
    `AthanLab: ${describeAthanLabError(error)}`,
    error?.code ?? "unavailable",
    retryAfterSeconds,
  );
}

/**
 * The only AthanLab detail that reaches the logs: never the key, the text, or
 * AthanLab's message (which may quote the text).
 */
export function logUpstream(phase: string, error: AthanLabError | null) {
  console.error("AthanLab request failed", {
    phase,
    status: error?.status ?? null,
    code: error?.code ?? null,
    requestId: error?.requestId ?? null,
  });
}

/** Charge one request against `limiter`'s per-user budget; a refusal is the response. */
export async function chargeRateLimit(
  c: Context,
  limiter: RateLimit | undefined,
  userId: string,
): Promise<Response | null> {
  if (!limiter) return notConfigured(c);
  const decision = await checkRateLimit(limiter, { key: `user:${userId}`, label: "AthanLab" });
  if (decision === "unavailable") return failure(c, 503, TEMPORARILY_UNAVAILABLE);
  return decision === "allowed"
    ? null
    : retryLater(
        c,
        "rate_limited",
        "Too many AthanLab requests — wait a minute",
        RATE_LIMIT_RETRY_SECONDS,
      );
}
