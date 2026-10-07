import { Hono, type Context } from "hono";
import { requireUser, type SignedInEnv } from "../auth/requireUser";
import type { Env } from "../env";
import { readBodyWithLimit, type LimitedBody } from "../httpBody";
import {
  acquireCredentialProbe,
  deleteProviderCredential,
  getProviderCredential,
  invalidateProviderCredential,
  putProviderCredential,
  releaseCredentialProbe,
  type CredentialProvider,
} from "../../db/providerCredentials";
import {
  readBreaker,
  recordAuthBlocked,
  recordAuthFailure,
  refundKeyCheck,
  reserveKeyCheck,
} from "../athanlab/breaker";
import {
  ATHANLAB_KEY_PATTERN,
  ATHANLAB_VOICE_ID_PATTERN,
  DOWNLOAD_HEADERS_TIMEOUT_MS,
  POLL_TIMEOUT_MS,
  READ_TIMEOUT_MS,
  SUBMIT_TIMEOUT_MS,
  athanLabFetch,
  contentLengthOf,
  describeAthanLabError,
  guardStream,
  isTransientError,
  mediaTypeOf,
  readAthanLabError,
  readJsonBody,
  requestOnce,
  requestWithRetries,
  retryAfterSecondsOf,
  sanitizeAthanLabText,
  sleep,
  speechJobOf,
  type AthanLabError,
  type AthanLabFetched,
  type AthanLabRequestInit,
  type PhaseOutcome,
  type RetryContext,
  type SpeechJob,
} from "../athanlab/client";
import { keyVaultOf, openApiKey, sealApiKey, type KeyVault } from "../athanlab/keyVault";

// Burmese Studio narration with each user's own AthanLab API key.
//
// athanlabRoute is mounted at /api/studio/athanlab (key, voices, voice sample,
// usage) and athanlabTtsRoute at /api/studio/tts/athanlab, beside the VoxCPM2
// route in studio.ts. The browser never sees a stored key again after pasting
// it: every AthanLab call happens here (see athanlab/client.ts), a key
// AthanLab has rejected is never sent again (see invalidateStoredKey), and
// each request's first call with a stored key is made under a per-user lease,
// so concurrent requests carrying a revoked key do not each cost a failed
// authentication (see firstContact).
export const athanlabRoute = new Hono<{ Bindings: Env }>();
export const athanlabTtsRoute = new Hono<{ Bindings: Env }>();

type SignedInContext = Context<SignedInEnv>;

const PROVIDER: CredentialProvider = "athanlab";

const MAX_KEY_REQUEST_BYTES = 1024;
const MAX_TTS_REQUEST_BYTES = 64 * 1024;
// AthanLab counts UTF-16 code units (String.length), as this check does.
const MAX_TEXT_CHARS = 5_000;
const MAX_VOICES = 200;
const MAX_VOICE_NAME_CHARS = 120;
const MAX_VOICE_CATEGORY_CHARS = 60;
const MAX_VOICE_LIST_BYTES = 512 * 1024;
// Jobs, quotes, usage, previews: a few hundred bytes each.
const MAX_JSON_BYTES = 64 * 1024;
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
const MAX_SAMPLE_REDIRECTS = 3;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const UPGRADE_ORIGIN = "https://athanlab.com";
// The free key check: "Hello." AthanLab quotes it without creating a job.
const VERIFY_TEXT = "မင်္ဂလာပါ။";
const WAV_MEDIA_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);
const AUDIO_MEDIA_TYPE_PATTERN = /^audio\/[a-z0-9.+-]{1,64}$/;

// One browser request drives one dialog's synthesis for at most this long,
// then hands back `still_processing` with the job left running: AthanLab may
// queue a job for up to 45 minutes, and the browser's next POST re-attaches
// to the same job through its idempotency key.
const SYNTHESIS_DEADLINE_MS = 240_000;
// Submits, polls and downloads together stay under the 50-subrequest Workers
// Free limit, and the last three are kept for downloading finished audio.
const SUBREQUEST_BUDGET = 45;
const DOWNLOAD_RESERVE = 3;
// Fresh (charged) jobs one browser request may start; idempotent replays of
// earlier jobs are free and do not count.
const MAX_FRESH_JOBS = 3;
// Attempt keys run base, base.r1 … base.r7, so one user's dialog starts at
// most eight jobs within AthanLab's 24-hour idempotency window (and a failed
// job is refunded in full).
const MAX_RETRY_KEY = 7;
const STILL_PROCESSING_RETRY_SECONDS = 5;
const DEFAULT_FIRST_POLL_MS = 2_000;
const MIN_FIRST_POLL_MS = 1_000;

// The first-contact lease (see firstContact). A holder releases it as soon as
// AthanLab has answered; one that never does (a stalled or cancelled request)
// frees the key once the lease lapses — LEASE_MARGIN_MS past the timeout of
// the one attempt it guards, so a live first attempt is never outlived by its
// lease. Others re-check every FIRST_CONTACT_POLL_MS for up to
// FIRST_CONTACT_WAIT_MS, then give up.
const LEASE_MARGIN_MS = 5_000;
const FIRST_CONTACT_POLL_MS = 200;
const FIRST_CONTACT_WAIT_MS = 5_000;
const KEY_BUSY_RETRY_SECONDS = 2;
// A per-user Rate Limiting period is 60 s.
const RATE_LIMIT_RETRY_SECONDS = 60;

const NOT_CONFIGURED = "AthanLab narration is not configured on this server";
const KEY_MISSING = "Connect your AthanLab API key first";
const KEY_INVALID =
  "AthanLab rejected your saved API key — it may have expired or been revoked. Connect a new key.";
const KEY_STALE = "Your saved AthanLab key can no longer be read — connect it again";
const INVALID_FORMAT =
  "That is not an AthanLab API key (it starts with ak_live_ followed by 32 characters)";
const KEY_BUSY =
  "Another request is checking your AthanLab key with AthanLab — try again in a moment";
const KEY_REPLACED = "Your AthanLab key was just replaced — try again";
const KEY_CHECKS_PAUSED = "AthanLab key checks are paused for a few minutes — try again soon";
const TEMPORARILY_UNAVAILABLE = "AthanLab narration is temporarily unavailable — try again soon";

type ErrorStatus = 400 | 409 | 413 | 429 | 502 | 503;

/** Every JSON error here: `{error, code?, retryAfterSeconds?}`. */
function failure(
  c: Context,
  status: ErrorStatus,
  error: string,
  code?: string | null,
  retryAfterSeconds?: number,
) {
  const body: { error: string; code?: string; retryAfterSeconds?: number } = { error };
  if (code) body.code = code;
  if (retryAfterSeconds !== undefined) body.retryAfterSeconds = retryAfterSeconds;
  return c.json(body, status);
}

function notConfigured(c: Context) {
  return failure(c, 503, NOT_CONFIGURED, "not_configured");
}

function authBlocked(c: Context, blockedUntil: number) {
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

function keyChecksPaused(c: Context) {
  return failure(c, 503, KEY_CHECKS_PAUSED, "key_checks_paused");
}

function stillProcessing(c: Context) {
  return failure(
    c,
    503,
    "AthanLab is still generating this dialog",
    "still_processing",
    STILL_PROCESSING_RETRY_SECONDS,
  );
}

function unavailable(c: Context, error: AthanLabError | null, retryAfterSeconds: number) {
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
function logUpstream(phase: string, error: AthanLabError | null) {
  console.error("AthanLab request failed", {
    phase,
    status: error?.status ?? null,
    code: error?.code ?? null,
    requestId: error?.requestId ?? null,
  });
}

/** Charge one request against `limiter`'s per-user budget; a refusal is the response. */
async function chargeRateLimit(
  c: Context,
  limiter: RateLimit | undefined,
  userId: string,
): Promise<Response | null> {
  if (!limiter) return notConfigured(c);
  let success: boolean;
  try {
    ({ success } = await limiter.limit({ key: `user:${userId}` }));
  } catch {
    console.error("AthanLab rate-limit check failed");
    return failure(c, 503, TEMPORARILY_UNAVAILABLE);
  }
  return success
    ? null
    : failure(
        c,
        429,
        "Too many AthanLab requests — wait a minute",
        "rate_limited",
        RATE_LIMIT_RETRY_SECONDS,
      );
}

interface StoredKey {
  userId: string;
  apiKey: string;
  /** The row's nonce: identifies exactly which sealed key was used. */
  iv: string;
  /** This request has already marked the key invalid. */
  invalidated: boolean;
}

/**
 * Everything a route that sends the stored key must clear first: AthanLab is
 * not blocking us, the user's budget has room, and a usable key is stored.
 * A row AthanLab rejected, or one that no longer decrypts, is reported without
 * contacting AthanLab.
 */
async function storedKeyAccess(c: SignedInContext, vault: KeyVault): Promise<StoredKey | Response> {
  const userId = c.get("user").id;
  const { blockedUntil } = await readBreaker(c.env.DB);
  if (blockedUntil > Date.now()) return authBlocked(c, blockedUntil);

  const limited = await chargeRateLimit(c, c.env.ATHANLAB_API_RATE_LIMITER, userId);
  if (limited) return limited;

  const row = await getProviderCredential(c.env.DB, userId, PROVIDER);
  if (!row) return failure(c, 409, KEY_MISSING, "key_missing");
  if (row.invalidated_at !== null) return failure(c, 409, KEY_INVALID, "key_invalid");

  const apiKey = await openApiKey(vault, userId, row).catch(() => null);
  if (apiKey === null || !ATHANLAB_KEY_PATTERN.test(apiKey)) {
    return failure(c, 409, KEY_STALE, "key_stale");
  }
  return { userId, apiKey, iv: row.iv, invalidated: false };
}

/** Never send this key again; a D1 failure is logged, not surfaced. */
async function invalidateStoredKey(db: D1Database, key: StoredKey) {
  if (key.invalidated) return;
  key.invalidated = true;
  try {
    await invalidateProviderCredential(db, key.userId, PROVIDER, Date.now(), key.iv);
  } catch {
    console.error("AthanLab key could not be marked invalid");
  }
}

/**
 * Wait for the first-contact lease on the stored key. Returns its token, or
 * the response when the key turned out invalid or gone while waiting (without
 * AthanLab hearing of it), when the lease stayed taken for
 * FIRST_CONTACT_WAIT_MS, or when D1 failed (the lease is a safety gate, so
 * that refuses the request rather than skipping it).
 */
async function acquireFirstContact(
  c: SignedInContext,
  key: StoredKey,
  leaseMs: number,
): Promise<string | Response> {
  const db = c.env.DB;
  const token = crypto.randomUUID();
  const giveUpAt = Date.now() + FIRST_CONTACT_WAIT_MS;
  try {
    for (let waited = false; ; waited = true) {
      const now = Date.now();
      if (await acquireCredentialProbe(db, key.userId, PROVIDER, key.iv, token, now, leaseMs)) {
        if (!waited) return token;
        // The holder this request waited for may have met auth_blocked; the
        // breaker then speaks for AthanLab until the block ends.
        const { blockedUntil } = await readBreaker(db);
        if (blockedUntil <= Date.now()) return token;
        await releaseFirstContact(db, key, token);
        return authBlocked(c, blockedUntil);
      }
      const row = await getProviderCredential(db, key.userId, PROVIDER);
      if (!row) return failure(c, 409, KEY_MISSING, "key_missing");
      // Checked before invalidation: the key this request decrypted may be the
      // revoked one the user just replaced, and the new one is not invalid.
      if (row.iv !== key.iv) {
        return failure(c, 503, KEY_REPLACED, "key_busy", KEY_BUSY_RETRY_SECONDS);
      }
      if (row.invalidated_at !== null) return failure(c, 409, KEY_INVALID, "key_invalid");
      if (Date.now() >= giveUpAt) {
        return failure(c, 503, KEY_BUSY, "key_busy", KEY_BUSY_RETRY_SECONDS);
      }
      await sleep(FIRST_CONTACT_POLL_MS);
    }
  } catch {
    console.error("AthanLab key lease could not be taken");
    return failure(c, 503, TEMPORARILY_UNAVAILABLE);
  }
}

/** A D1 failure is logged: the lease then lapses by itself. */
async function releaseFirstContact(db: D1Database, key: StoredKey, token: string) {
  try {
    await releaseCredentialProbe(db, key.userId, PROVIDER, token);
  } catch {
    console.error("AthanLab key lease could not be released");
  }
}

function isUnauthorized(outcome: { kind: string; error?: AthanLabError | null }): boolean {
  return outcome.kind === "rejected" && outcome.error?.status === 401;
}

/**
 * Make a request's first AthanLab call with the stored key — and only that
 * call — under the user's first-contact lease (user_provider_credentials
 * probe_token/probe_until), released as soon as AthanLab has answered it. A
 * 401 marks the key invalid before the lease is released, so a request
 * waiting for the lease then answers key_invalid without sending the key.
 * However many requests carry a key AthanLab has just revoked, one of them
 * meets the 401 and the rest never send it — even when the user replaces the
 * key meanwhile, since the lease belongs to one sealed key (its iv). The
 * lease outlives the first attempt (`attemptTimeoutMs` + LEASE_MARGIN_MS); only
 * a synthesis's first submit still retrying transient failures past that lets
 * the next request try as well, and AthanLab answering those attempts at all
 * means the key was still accepted. A request already past its first call (a
 * synthesis polling its job) is not held back.
 */
async function firstContact<T extends { kind: string }>(
  c: SignedInContext,
  key: StoredKey,
  attemptTimeoutMs: number,
  call: () => Promise<T>,
): Promise<T | Response> {
  const token = await acquireFirstContact(c, key, attemptTimeoutMs + LEASE_MARGIN_MS);
  if (token instanceof Response) return token;
  try {
    const outcome = await call();
    if (isUnauthorized(outcome)) await invalidateStoredKey(c.env.DB, key);
    return outcome;
  } finally {
    await releaseFirstContact(c.env.DB, key, token);
  }
}

/** The response to a final AthanLab error on a route that sent the stored key. */
async function storedKeyRejection(
  c: SignedInContext,
  key: StoredKey,
  error: AthanLabError,
  phase: string,
): Promise<Response> {
  logUpstream(phase, error);
  if (error.status === 401) {
    await invalidateStoredKey(c.env.DB, key);
    await recordAuthFailure(c.env.DB);
    return failure(c, 409, KEY_INVALID, "key_invalid");
  }
  if (error.code === "auth_blocked") {
    return authBlocked(c, await recordAuthBlocked(c.env.DB, error.retryAfterSeconds));
  }
  if (isTransientError(error)) {
    return unavailable(c, error, Math.max(1, error.retryAfterSeconds ?? 1));
  }
  return failure(c, 502, describeAthanLabError(error), error.code);
}

/** The response to any phase outcome other than "ok". */
async function outcomeFailure(
  c: SignedInContext,
  key: StoredKey,
  outcome: Exclude<PhaseOutcome, { kind: "ok" }>,
  phase: string,
): Promise<Response> {
  switch (outcome.kind) {
    case "rejected":
      return storedKeyRejection(c, key, outcome.error, phase);
    case "unavailable":
      logUpstream(phase, outcome.error);
      return unavailable(c, outcome.error, outcome.retryAfterSeconds);
    case "out_of_budget":
      return stillProcessing(c);
  }
}

function readJsonGet(path: string): AthanLabRequestInit {
  return { method: "GET", path, accept: "application/json", timeoutMs: READ_TIMEOUT_MS };
}

// ---------------------------------------------------------------------------
// The key

athanlabRoute.get("/key", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);
  const userId = c.get("user").id;

  const row = await getProviderCredential(c.env.DB, userId, PROVIDER);
  if (!row) return c.json({ connected: false });
  const hint = `…${row.key_hint}`;
  if (row.invalidated_at !== null) {
    return c.json({ connected: false, invalid: true, hint, updatedAt: row.updated_at });
  }
  const apiKey = await openApiKey(vault, userId, row).catch(() => null);
  if (apiKey === null || !ATHANLAB_KEY_PATTERN.test(apiKey)) {
    return c.json({ connected: false, stale: true });
  }
  return c.json({ connected: true, hint, updatedAt: row.updated_at });
});

type KeyRequest = { ok: true; apiKey: string } | { ok: false; status: 400 | 413; error: string };

async function readKeyRequest(request: Request): Promise<KeyRequest> {
  const requestBody = await readBodyWithLimit(request, MAX_KEY_REQUEST_BYTES);
  if (requestBody.status === "too-large") {
    return { ok: false, status: 413, error: "request body is too large" };
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
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as { apiKey?: unknown }).apiKey !== "string"
  ) {
    return { ok: false, status: 400, error: "'apiKey' is the only supported field" };
  }
  return { ok: true, apiKey: (body as { apiKey: string }).apiKey };
}

interface KeyQuote {
  spendable: number | null;
  sufficient: boolean | null;
}

/**
 * One key check under way. Its breaker slot is kept when AthanLab answered
 * 401 — and when a call's outcome is unknown (it threw or timed out after the
 * key may have left), since AthanLab may have counted that as a failed
 * authentication too.
 */
interface KeyCheck {
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
async function verifyApiKey(
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

athanlabRoute.put("/key", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);
  const userId = c.get("user").id;

  // A plain read first, so a paused or blocked breaker costs nobody budget.
  // It decides nothing under concurrency: the reservation below does.
  const breaker = await readBreaker(c.env.DB);
  if (breaker.blockedUntil > Date.now()) return authBlocked(c, breaker.blockedUntil);
  if (breaker.keyChecksPaused) return keyChecksPaused(c);

  const limited = await chargeRateLimit(c, c.env.ATHANLAB_KEY_RATE_LIMITER, userId);
  if (limited) return limited;

  const request = await readKeyRequest(c.req.raw);
  if (!request.ok) return failure(c, request.status, request.error, "invalid_request");
  // Checked before AthanLab hears of it: a malformed key would still count
  // as a failed authentication against our shared network.
  const apiKey = request.apiKey.trim();
  if (!ATHANLAB_KEY_PATTERN.test(apiKey)) return failure(c, 400, INVALID_FORMAT, "invalid_format");

  // The check is counted as a failed authentication before AthanLab hears of
  // the key, so concurrent checks cannot all pass a breaker that has room for
  // one; it gets the slot back only on a definite answer other than 401.
  const reservation = await reserveKeyCheck(c.env.DB);
  switch (reservation.kind) {
    case "blocked":
      return authBlocked(c, reservation.blockedUntil);
    case "paused":
      return keyChecksPaused(c);
    case "unavailable":
      return failure(c, 503, TEMPORARILY_UNAVAILABLE);
  }
  const check: KeyCheck = { unauthorized: false, uncertain: false };
  let quote: KeyQuote | Response;
  try {
    quote = await verifyApiKey(c, apiKey, check);
  } finally {
    if (!check.unauthorized && !check.uncertain) {
      await refundKeyCheck(c.env.DB, reservation.windowStartedAt);
    }
  }
  if (quote instanceof Response) return quote;

  const sealed = await sealApiKey(vault, userId, apiKey);
  const keyHint = apiKey.slice(-4);
  const now = Date.now();
  await putProviderCredential(c.env.DB, {
    userId,
    provider: PROVIDER,
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion,
    keyHint,
    now,
  });
  return c.json({ connected: true, hint: `…${keyHint}`, updatedAt: now, quote });
});

// Removing a key needs no vault: it must work even while AthanLab narration is
// misconfigured, so nobody is left unable to delete what they stored.
athanlabRoute.delete("/key", requireUser, async (c) => {
  await deleteProviderCredential(c.env.DB, c.get("user").id, PROVIDER);
  return c.json({ connected: false });
});

// ---------------------------------------------------------------------------
// Voices, voice samples, usage

interface VoiceSummary {
  id: string;
  name: string;
  category: string;
  source: "athanlab" | "user";
  isDefault: boolean;
}

function voiceListOf(
  payload: unknown,
  apiKey: string,
): { voices: VoiceSummary[]; defaultVoiceId: string | null } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { data, default_voice_id: defaultVoiceId } = payload as Record<string, unknown>;
  if (!Array.isArray(data)) return null;

  const voices: VoiceSummary[] = [];
  for (const entry of data) {
    if (voices.length >= MAX_VOICES) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { id, name, category, source, is_default: isDefault } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !ATHANLAB_VOICE_ID_PATTERN.test(id)) continue;
    if (source !== "athanlab" && source !== "user") continue;
    voices.push({
      id,
      name:
        (typeof name === "string"
          ? sanitizeAthanLabText(name, apiKey, MAX_VOICE_NAME_CHARS)
          : null) ?? id,
      category:
        (typeof category === "string"
          ? sanitizeAthanLabText(category, apiKey, MAX_VOICE_CATEGORY_CHARS)
          : null) ?? "",
      source,
      isDefault: isDefault === true,
    });
  }
  return {
    voices,
    defaultVoiceId:
      typeof defaultVoiceId === "string" && voices.some((voice) => voice.id === defaultVoiceId)
        ? defaultVoiceId
        : null,
  };
}

athanlabRoute.get("/voices", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);
  const key = await storedKeyAccess(c, vault);
  if (key instanceof Response) return key;

  const outcome = await firstContact(c, key, READ_TIMEOUT_MS, () =>
    requestOnce(key.apiKey, readJsonGet("/voices")),
  );
  if (outcome instanceof Response) return outcome;
  if (outcome.kind !== "ok") return outcomeFailure(c, key, outcome, "voices");
  let payload: unknown;
  try {
    payload = await readJsonBody(outcome.response, MAX_VOICE_LIST_BYTES);
  } finally {
    outcome.done();
  }
  const list = voiceListOf(payload, key.apiKey);
  if (!list) {
    return failure(c, 502, "AthanLab returned an unexpected voice list", "unexpected_response");
  }
  return c.json(list);
});

/** An https URL without credentials, or null. */
function safeHttpsUrl(raw: unknown, base?: URL): URL | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  return url.protocol === "https:" && !url.username && !url.password ? url : null;
}

const SAMPLE_UNAVAILABLE = "This AthanLab voice sample could not be loaded";

/**
 * Fetch a voice sample from AthanLab's signed preview URL, with no key, and
 * follow only https redirects. The sample is streamed back from this origin
 * because the app is cross-origin isolated (COEP require-corp): an
 * `<audio src>` pointing at AthanLab's storage would be blocked.
 */
async function fetchSample(url: URL): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_SAMPLE_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        headers: { Accept: "audio/*" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel().catch(() => undefined);
    const next = safeHttpsUrl(response.headers.get("location"), current);
    if (!next) return null;
    current = next;
  }
  return null;
}

athanlabRoute.get("/voices/:id/sample", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);
  const voiceId = c.req.param("id");
  if (!ATHANLAB_VOICE_ID_PATTERN.test(voiceId)) {
    return failure(c, 400, "That is not an AthanLab voice id", "invalid_voice");
  }
  const key = await storedKeyAccess(c, vault);
  if (key instanceof Response) return key;

  const outcome = await firstContact(c, key, READ_TIMEOUT_MS, () =>
    requestOnce(key.apiKey, readJsonGet(`/voices/${encodeURIComponent(voiceId)}/preview`)),
  );
  if (outcome instanceof Response) return outcome;
  if (outcome.kind !== "ok") return outcomeFailure(c, key, outcome, "voice-preview");
  let payload: unknown;
  try {
    payload = await readJsonBody(outcome.response, MAX_JSON_BYTES);
  } finally {
    outcome.done();
  }
  const sampleUrl = safeHttpsUrl(
    typeof payload === "object" && payload !== null ? (payload as { url?: unknown }).url : null,
  );
  if (!sampleUrl) return failure(c, 502, SAMPLE_UNAVAILABLE, "sample_unavailable");

  const sample = await fetchSample(sampleUrl);
  const mediaType = sample ? mediaTypeOf(sample) : "";
  const declared = sample ? contentLengthOf(sample) : null;
  if (
    !sample?.ok ||
    !sample.body ||
    !AUDIO_MEDIA_TYPE_PATTERN.test(mediaType) ||
    (declared !== null && declared > MAX_SAMPLE_BYTES)
  ) {
    await sample?.body?.cancel().catch(() => undefined);
    console.error("AthanLab voice sample was refused", {
      status: sample?.status ?? null,
      contentType: mediaType || null,
    });
    return failure(c, 502, SAMPLE_UNAVAILABLE, "sample_unavailable");
  }
  return new Response(
    guardStream(sample.body, {
      maxBytes: MAX_SAMPLE_BYTES,
      idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
      expectedBytes: declared,
    }),
    {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": mediaType,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
});

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** AthanLab's upgrade page, and nothing else, may be linked from Studio. */
function upgradeUrlOf(value: unknown): string | null {
  const url = safeHttpsUrl(value);
  return url?.origin === UPGRADE_ORIGIN ? url.toString() : null;
}

athanlabRoute.get("/usage", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);
  const key = await storedKeyAccess(c, vault);
  if (key instanceof Response) return key;

  const outcome = await firstContact(c, key, READ_TIMEOUT_MS, () =>
    requestOnce(key.apiKey, readJsonGet("/usage")),
  );
  if (outcome instanceof Response) return outcome;
  // usage:read is optional, so a key without it simply has no balance to show.
  if (outcome.kind === "rejected" && outcome.error.code === "scope_missing") {
    return c.json({ available: false });
  }
  if (outcome.kind !== "ok") return outcomeFailure(c, key, outcome, "usage");
  let payload: unknown;
  try {
    payload = await readJsonBody(outcome.response, MAX_JSON_BYTES);
  } finally {
    outcome.done();
  }
  if (typeof payload !== "object" || payload === null) {
    return failure(c, 502, "AthanLab returned unexpected usage", "unexpected_response");
  }

  const usage = payload as Record<string, unknown>;
  const monthly = recordOf(usage.monthly);
  const tokens = recordOf(usage.tokens);
  const keyUsage = recordOf(usage.key);
  return c.json({
    available: true,
    spendable: nonNegativeIntegerOrNull(usage.spendable),
    entitled: typeof usage.entitled === "boolean" ? usage.entitled : null,
    upgradeUrl: upgradeUrlOf(usage.upgrade_url),
    monthly: {
      limit: nonNegativeIntegerOrNull(monthly.limit),
      used: nonNegativeIntegerOrNull(monthly.used),
      remaining: nonNegativeIntegerOrNull(monthly.remaining),
      resetsAt: isoDateOrNull(monthly.resets_at),
    },
    tokens: { balance: nonNegativeIntegerOrNull(tokens.balance) },
    key: {
      monthlyCharBudget: nonNegativeIntegerOrNull(keyUsage.monthly_char_budget),
      remaining: nonNegativeIntegerOrNull(keyUsage.remaining),
    },
  });
});

// ---------------------------------------------------------------------------
// Synthesis

type TtsRequest =
  | { ok: true; text: string; voiceId: string }
  | { ok: false; status: 400 | 413; error: string; code: string };

async function readTtsRequest(request: Request): Promise<TtsRequest> {
  const requestBody = await readBodyWithLimit(request, MAX_TTS_REQUEST_BYTES);
  if (requestBody.status === "too-large") {
    return { ok: false, status: 413, error: "request body is too large", code: "invalid_request" };
  }
  if (requestBody.status === "read-error") {
    return {
      ok: false,
      status: 400,
      error: "request body could not be read",
      code: "invalid_request",
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(requestBody.text);
  } catch {
    return { ok: false, status: 400, error: "invalid JSON body", code: "invalid_request" };
  }
  const keys = typeof body === "object" && body !== null ? Object.keys(body).sort() : [];
  if (Array.isArray(body) || keys.length !== 2 || keys[0] !== "text" || keys[1] !== "voiceId") {
    return {
      ok: false,
      status: 400,
      error: "'text' and 'voiceId' are the only supported fields",
      code: "invalid_request",
    };
  }
  const { text: rawText, voiceId } = body as Record<string, unknown>;
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text || text.length > MAX_TEXT_CHARS) {
    return {
      ok: false,
      status: 400,
      error: `'text' must contain 1-${MAX_TEXT_CHARS} characters`,
      code: "invalid_text",
    };
  }
  if (typeof voiceId !== "string" || !ATHANLAB_VOICE_ID_PATTERN.test(voiceId)) {
    return {
      ok: false,
      status: 400,
      error: "'voiceId' is not an AthanLab voice id",
      code: "invalid_voice",
    };
  }
  return { ok: true, text, voiceId };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The retry rule of requestWithRetries (athanlab/client.ts), restated here
// because that function returns at the response headers and so cannot count a
// body that fails afterwards.
const MAX_TRANSIENT_FAILURES = 3;
const MIN_RETRY_WAIT_MS = 1_000;
const MAX_RETRY_WAIT_MS = 30_000;

type JsonPhaseOutcome =
  | {
      kind: "ok";
      /** Headers only: the body has been read. */
      response: Response;
      /** Undefined when a body that arrived whole is not JSON or is too large. */
      payload: unknown;
    }
  | Exclude<PhaseOutcome, { kind: "ok" }>;

/**
 * requestWithRetries for submit and poll, with the JSON body read as part of
 * each attempt: a body that breaks off after the headers (a timeout, an
 * abort, a truncated stream) is a transient failure like a failed fetch, and
 * is asked for again under the same rule — safe, since a submit repeats its
 * idempotency key and a poll only reads. A body that arrives whole but is too
 * large or not JSON is final. The phase timeout covers the body too.
 */
async function requestJsonWithRetries(
  context: RetryContext,
  init: AthanLabRequestInit,
  reserve: number,
): Promise<JsonPhaseOutcome> {
  for (let failures = 1; ; failures++) {
    if (context.budget.used + reserve >= context.budget.limit) return { kind: "out_of_budget" };
    context.budget.used++;

    let fetched: AthanLabFetched | null;
    try {
      fetched = await athanLabFetch(context.apiKey, init);
    } catch {
      fetched = null;
    }

    let error: AthanLabError | null = null;
    if (fetched?.response.ok) {
      const { response } = fetched;
      let body: LimitedBody;
      try {
        body = await readBodyWithLimit(response, MAX_JSON_BYTES);
      } finally {
        fetched.done();
      }
      if (body.status === "ok") {
        return { kind: "ok", response, payload: parseJsonOrUndefined(body.text) };
      }
      if (body.status === "too-large") {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "ok", response, payload: undefined };
      }
      // "read-error": transient, with no AthanLab error to quote.
    } else if (fetched) {
      try {
        error = await readAthanLabError(fetched.response, context.apiKey);
      } finally {
        fetched.done();
      }
      if (error.code === "auth_blocked" || !isTransientError(error)) {
        return { kind: "rejected", error };
      }
    }

    const waitMs =
      error?.retryAfterSeconds != null
        ? Math.max(MIN_RETRY_WAIT_MS, error.retryAfterSeconds * 1000)
        : MIN_RETRY_WAIT_MS * 2 ** (failures - 1);
    if (
      failures >= MAX_TRANSIENT_FAILURES ||
      waitMs > MAX_RETRY_WAIT_MS ||
      Date.now() + waitMs > context.deadline
    ) {
      return { kind: "unavailable", error, retryAfterSeconds: Math.ceil(waitMs / 1000) };
    }
    await sleep(waitMs);
  }
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** How long to wait before the next poll, by how long the job has been followed. */
function pollIntervalMs(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 3_000;
  if (elapsedMs < 90_000) return 5_000;
  return 10_000;
}

type PollResult =
  | { kind: "finished"; job: SpeechJob }
  | { kind: "still_processing" }
  | { kind: "unexpected" }
  | Exclude<PhaseOutcome, { kind: "ok" | "out_of_budget" }>;

/**
 * Poll a processing job until it finishes, or until the deadline or the
 * subrequest budget (less the download reserve) would run out — then the job
 * is left running for the browser's next request to re-attach to.
 */
async function pollJob(
  context: RetryContext,
  jobId: string,
  firstWaitMs: number,
): Promise<PollResult> {
  const startedAt = Date.now();
  let waitMs = firstWaitMs;
  for (;;) {
    if (
      Date.now() + waitMs >= context.deadline ||
      context.budget.used + DOWNLOAD_RESERVE >= context.budget.limit
    ) {
      return { kind: "still_processing" };
    }
    await sleep(waitMs);

    const outcome = await requestJsonWithRetries(
      context,
      {
        method: "GET",
        path: `/speech/${jobId}`,
        accept: "application/json",
        timeoutMs: POLL_TIMEOUT_MS,
      },
      DOWNLOAD_RESERVE,
    );
    if (outcome.kind === "out_of_budget") return { kind: "still_processing" };
    if (outcome.kind !== "ok") return outcome;
    const job = speechJobOf(outcome.payload, context.apiKey);
    if (!job || job.id !== jobId) return { kind: "unexpected" };
    if (job.status !== "processing") return { kind: "finished", job };
    waitMs = pollIntervalMs(Date.now() - startedAt);
  }
}

type DownloadResult =
  | { kind: "audio"; response: Response }
  | { kind: "expired"; error: AthanLabError }
  | { kind: "failed"; response: Response };

/**
 * Download a finished job's WAV and stream it straight to the browser. Only
 * the response headers are under a timeout; the body then passes a guard that
 * errors on a 30 s stall, past 64 MiB, or short of its Content-Length, so a
 * truncated file never reaches the browser as a complete one.
 */
async function downloadAudio(
  c: SignedInContext,
  key: StoredKey,
  context: RetryContext,
  jobId: string,
): Promise<DownloadResult> {
  const outcome = await requestWithRetries(context, {
    method: "GET",
    path: `/speech/${jobId}/audio?format=wav`,
    accept: "audio/wav",
    timeoutMs: DOWNLOAD_HEADERS_TIMEOUT_MS,
  });
  if (outcome.kind === "rejected" && outcome.error.code === "audio_expired") {
    logUpstream("download", outcome.error);
    return { kind: "expired", error: outcome.error };
  }
  if (outcome.kind !== "ok") {
    return { kind: "failed", response: await outcomeFailure(c, key, outcome, "download") };
  }
  outcome.done();

  const { response } = outcome;
  const mediaType = mediaTypeOf(response);
  const declared = contentLengthOf(response);
  if (
    !WAV_MEDIA_TYPES.has(mediaType) ||
    !response.body ||
    declared === 0 ||
    (declared !== null && declared > MAX_AUDIO_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    console.error("AthanLab returned unexpected audio", {
      status: response.status,
      contentType: mediaType || null,
      contentLength: declared,
    });
    const received = mediaType
      ? `"${sanitizeAthanLabText(mediaType, key.apiKey, 80) ?? "unknown"}"`
      : "no content type";
    return {
      kind: "failed",
      response: failure(
        c,
        502,
        WAV_MEDIA_TYPES.has(mediaType)
          ? "AthanLab returned an empty or oversized audio file"
          : `AthanLab returned ${received} instead of WAV audio`,
        "unexpected_response",
      ),
    };
  }

  return {
    kind: "audio",
    response: new Response(
      guardStream(response.body, {
        maxBytes: MAX_AUDIO_BYTES,
        idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
        expectedBytes: declared,
      }),
      {
        status: 200,
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": "audio/wav",
          "X-Content-Type-Options": "nosniff",
        },
      },
    ),
  };
}

/**
 * Speak one dialog. The request body AthanLab receives is serialized once,
 * and its idempotency key is derived from exactly that string, so the same
 * dialog for the same user always re-attaches to the same job: a retried
 * browser request, or one after `still_processing`, is never charged again.
 *
 * A job is never cancelled. It ends one of four ways: its audio is streamed
 * back; it failed retryably, was cancelled elsewhere, or its audio expired,
 * and the next attempt key starts a new job (at most three fresh jobs per
 * request, and never past base.r7); it failed for good (502); or time or
 * subrequests ran out while it was processing (503 still_processing).
 */
async function synthesize(
  c: SignedInContext,
  key: StoredKey,
  text: string,
  voiceId: string,
): Promise<Response> {
  const body = JSON.stringify({
    text,
    voice_id: voiceId,
    output_format: "wav",
    number_mode: "smart",
    metadata: { source: "next-editor-studio" },
  });
  const idempotencyBase = `ne1:${await sha256Hex(`${c.get("user").id}\n${body}`)}`;
  const context: RetryContext = {
    apiKey: key.apiKey,
    deadline: Date.now() + SYNTHESIS_DEADLINE_MS,
    budget: { used: 0, limit: SUBREQUEST_BUDGET },
  };

  let freshJobs = 0;
  let advancedOnConflict = false;
  let lastFailure = { message: "AthanLab did not finish this dialog", code: "generation_failed" };
  for (let attempt = 0; attempt <= MAX_RETRY_KEY; attempt++) {
    const submit = () =>
      requestJsonWithRetries(
        context,
        {
          method: "POST",
          path: "/speech",
          accept: "application/json",
          body,
          idempotencyKey: attempt === 0 ? idempotencyBase : `${idempotencyBase}.r${attempt}`,
          timeoutMs: SUBMIT_TIMEOUT_MS,
        },
        DOWNLOAD_RESERVE,
      );
    // The first submit, transient retries included, is this request's first
    // contact; later submits, polls and downloads follow an answer.
    const submitted =
      attempt === 0 ? await firstContact(c, key, SUBMIT_TIMEOUT_MS, submit) : await submit();
    if (submitted instanceof Response) return submitted;
    if (submitted.kind !== "ok") {
      if (
        submitted.kind === "rejected" &&
        submitted.error.code === "idempotency_conflict" &&
        !advancedOnConflict
      ) {
        // Same key, different body: only a change to how the body is built
        // can cause this. Move past the key once rather than fail the dialog.
        advancedOnConflict = true;
        console.error("AthanLab idempotency conflict", {
          requestId: submitted.error.requestId,
          jobId: submitted.error.details.jobId ?? null,
        });
        continue;
      }
      return outcomeFailure(c, key, submitted, "submit");
    }

    const replayed = submitted.response.headers.get("idempotent-replayed") === "true";
    const retryAfterSeconds = retryAfterSecondsOf(submitted.response);
    const accepted = speechJobOf(submitted.payload, key.apiKey);
    if (!accepted) {
      console.error("AthanLab returned no speech job", { replayed });
      return failure(c, 502, "AthanLab returned no speech job", "unexpected_response");
    }
    if (!replayed) freshJobs++;

    let job = accepted;
    if (job.status === "processing") {
      const firstWaitMs =
        retryAfterSeconds === null
          ? DEFAULT_FIRST_POLL_MS
          : Math.max(MIN_FIRST_POLL_MS, retryAfterSeconds * 1000);
      const polled = await pollJob(context, job.id, firstWaitMs);
      switch (polled.kind) {
        case "still_processing":
          return stillProcessing(c);
        case "unexpected":
          console.error("AthanLab returned an unexpected job while polling");
          return failure(
            c,
            502,
            "AthanLab returned an unexpected speech job",
            "unexpected_response",
          );
        case "rejected":
        case "unavailable":
          return outcomeFailure(c, key, polled, "poll");
        case "finished":
          job = polled.job;
      }
    }

    if (job.status === "succeeded") {
      const downloaded = await downloadAudio(c, key, context, job.id);
      if (downloaded.kind !== "expired") return downloaded.response;
      lastFailure = {
        message: describeAthanLabError(downloaded.error),
        code: downloaded.error.code ?? "audio_expired",
      };
    } else if (job.status === "failed") {
      const message = job.error?.message ?? "the job failed";
      const code = job.error?.code ?? "generation_failed";
      if (!job.error?.retryable) {
        console.error("AthanLab job failed", { code, retryable: false });
        return failure(c, 502, `AthanLab could not speak this dialog: ${message}`, code);
      }
      lastFailure = { message, code };
    } else {
      lastFailure = { message: "the job was cancelled", code: "cancelled" };
    }

    if (freshJobs >= MAX_FRESH_JOBS) break;
  }

  console.error("AthanLab gave up on a dialog", { code: lastFailure.code, freshJobs });
  return failure(
    c,
    502,
    `AthanLab could not speak this dialog: ${lastFailure.message}`,
    lastFailure.code,
  );
}

athanlabTtsRoute.post("/", requireUser, async (c) => {
  const vault = keyVaultOf(c.env);
  if (!vault) return notConfigured(c);

  const request = await readTtsRequest(c.req.raw);
  if (!request.ok) return failure(c, request.status, request.error, request.code);

  const key = await storedKeyAccess(c, vault);
  if (key instanceof Response) return key;
  return synthesize(c, key, request.text, request.voiceId);
});
