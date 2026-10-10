import { recordAuthBlocked } from "./breaker";
import {
  ATHANLAB_VOICE_ID_PATTERN,
  READ_TIMEOUT_MS,
  describeAthanLabError,
  readJsonBody,
  readJsonGet,
  requestOnce,
  type PhaseOutcome,
} from "./client";
import { MAX_JSON_BYTES, MAX_VOICE_LIST_BYTES, nonNegativeIntegerOrNull, recordOf } from "./json";
import { authBlocked, failure, logUpstream, unavailable } from "./responses";
import type { SignedInContext } from "./storedKey";

// Checking a pasted AthanLab key before it is stored (PUT
// /api/studio/athanlab/key): free calls only, one per scope Studio needs.

// The free key check: "Hello." AthanLab quotes it without creating a job.
const VERIFY_TEXT = "မင်္ဂလာပါ။";

export interface KeyQuote {
  spendable: number | null;
  sufficient: boolean | null;
}

/**
 * One key check under way. Its breaker slot is kept when AthanLab answered
 * 401 — and when a call's outcome is unknown (it threw or timed out after the
 * key may have left), since AthanLab may have counted that as a failed
 * authentication too.
 */
export interface KeyCheck {
  unauthorized: boolean;
  uncertain: boolean;
}

/** The response to a failed key check: the key under test is not stored. */
async function verificationFailure(
  c: SignedInContext,
  check: KeyCheck,
  outcome: Exclude<PhaseOutcome, { kind: "ok" | "out_of_budget" }>,
  phase: string,
  scope: string,
): Promise<Response> {
  logUpstream(phase, outcome.error);
  if (outcome.kind === "unavailable") {
    // No AthanLab answer at all: whether it counted the key is unknown.
    if (outcome.error === null) check.uncertain = true;
    return outcome.error?.code === "api_read_only"
      ? failure(c, 503, "AthanLab is in maintenance — try again later", "api_read_only")
      : unavailable(c, outcome.error, outcome.retryAfterSeconds);
  }
  const { error } = outcome;
  if (error.status === 401) {
    // Already counted: the check's reservation becomes the recorded failure.
    check.unauthorized = true;
    return failure(c, 400, "AthanLab rejected this API key", "invalid_api_key");
  }
  if (error.code === "auth_blocked") {
    return authBlocked(c, await recordAuthBlocked(c.env.DB, error.retryAfterSeconds));
  }
  if (error.code === "scope_missing") {
    return failure(
      c,
      400,
      `This AthanLab key is missing the ${error.details.requiredScope ?? scope} permission — create a key with speech:write, speech:read and voices:read`,
      "scope_missing",
    );
  }
  const status = error.status >= 400 && error.status < 500 ? 400 : 502;
  return failure(c, status, `AthanLab: ${describeAthanLabError(error)}`, error.code);
}

/**
 * The voice a dry run names: AthanLab's default voice, else the first listed
 * one, else none. While AthanLab's default is unset (`default_voice_id: null`)
 * a dry run without a voice could refuse a working key.
 */
function dryRunVoiceIdOf(voices: unknown): string | null {
  const { data, default_voice_id: defaultVoiceId } = recordOf(voices);
  if (typeof defaultVoiceId === "string" && ATHANLAB_VOICE_ID_PATTERN.test(defaultVoiceId)) {
    return defaultVoiceId;
  }
  if (!Array.isArray(data)) return null;
  for (const entry of data) {
    const { id } = recordOf(entry);
    if (typeof id === "string" && ATHANLAB_VOICE_ID_PATTERN.test(id)) return id;
  }
  return null;
}

/**
 * Check a key with free calls only, each needing one scope Studio uses, and
 * stop at the first failure: list voices (voices:read), list jobs
 * (speech:read), then quote a dry run (speech:write, and the Max plan). Usage
 * is read last, best effort: usage:read is optional. So a check meets at most
 * one 401, which `check` records.
 */
export async function verifyApiKey(
  c: SignedInContext,
  apiKey: string,
  check: KeyCheck,
): Promise<KeyQuote | Response> {
  const voices = await requestOnce(apiKey, readJsonGet("/voices"));
  if (voices.kind !== "ok") {
    return verificationFailure(c, check, voices, "verify-voices", "voices:read");
  }
  let voiceList: unknown;
  try {
    voiceList = await readJsonBody(voices.response, MAX_VOICE_LIST_BYTES);
  } finally {
    voices.done();
  }

  const jobs = await requestOnce(apiKey, readJsonGet("/speech?limit=1"));
  if (jobs.kind !== "ok") {
    return verificationFailure(c, check, jobs, "verify-speech", "speech:read");
  }
  await jobs.response.body?.cancel().catch(() => undefined);
  jobs.done();

  const voiceId = dryRunVoiceIdOf(voiceList);
  const quoted = await requestOnce(apiKey, {
    method: "POST",
    path: "/speech",
    accept: "application/json",
    body: JSON.stringify({
      text: VERIFY_TEXT,
      ...(voiceId === null ? {} : { voice_id: voiceId }),
      dry_run: true,
    }),
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (quoted.kind !== "ok") {
    return verificationFailure(c, check, quoted, "verify-dry-run", "speech:write");
  }
  let payload: unknown;
  try {
    payload = await readJsonBody(quoted.response, MAX_JSON_BYTES);
  } finally {
    quoted.done();
  }
  const { spendable, sufficient } = (
    typeof payload === "object" && payload !== null ? payload : {}
  ) as Record<string, unknown>;

  const usage = await requestOnce(apiKey, readJsonGet("/usage"));
  if (usage.kind === "ok") {
    await usage.response.body?.cancel().catch(() => undefined);
    usage.done();
  } else if (usage.kind === "rejected" && usage.error.status === 401) {
    check.unauthorized = true;
  } else if (usage.kind === "rejected" && usage.error.code === "auth_blocked") {
    await recordAuthBlocked(c.env.DB, usage.error.retryAfterSeconds);
  }

  return {
    spendable: nonNegativeIntegerOrNull(spendable),
    sufficient: typeof sufficient === "boolean" ? sufficient : null,
  };
}
