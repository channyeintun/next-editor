import type { Context } from "hono";
import type { SignedInEnv } from "../auth/requireUser";
import {
  acquireCredentialProbe,
  getProviderCredential,
  invalidateProviderCredential,
  releaseCredentialProbe,
  type CredentialProvider,
} from "../../db/providerCredentials";
import { readBreaker, recordAuthBlocked, recordAuthFailure } from "./breaker";
import {
  ATHANLAB_KEY_PATTERN,
  describeAthanLabError,
  isTransientError,
  sleep,
  type AthanLabError,
  type PhaseOutcome,
} from "./client";
import { openApiKey, type KeyVault } from "./keyVault";
import {
  TEMPORARILY_UNAVAILABLE,
  authBlocked,
  chargeRateLimit,
  failure,
  logUpstream,
  retryLater,
  stillProcessing,
  unavailable,
} from "./responses";

// The user's stored AthanLab key on its way to AthanLab: the checks a route
// clears before sending it (storedKeyAccess), never sending a key AthanLab
// rejected again (invalidateStoredKey), and the per-user first-contact lease
// that keeps concurrent requests carrying a revoked key from each costing a
// failed authentication (firstContact).

export type SignedInContext = Context<SignedInEnv>;

export const PROVIDER: CredentialProvider = "athanlab";

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

const KEY_MISSING = "Connect your AthanLab API key first";
const KEY_INVALID =
  "AthanLab rejected your saved API key — it may have expired or been revoked. Connect a new key.";
const KEY_STALE = "Your saved AthanLab key can no longer be read — connect it again";
const KEY_BUSY =
  "Another request is checking your AthanLab key with AthanLab — try again in a moment";
const KEY_REPLACED = "Your AthanLab key was just replaced — try again";

export interface StoredKey {
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
export async function storedKeyAccess(
  c: SignedInContext,
  vault: KeyVault,
): Promise<StoredKey | Response> {
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
        return retryLater(c, "key_busy", KEY_REPLACED, KEY_BUSY_RETRY_SECONDS);
      }
      if (row.invalidated_at !== null) return failure(c, 409, KEY_INVALID, "key_invalid");
      if (Date.now() >= giveUpAt) {
        return retryLater(c, "key_busy", KEY_BUSY, KEY_BUSY_RETRY_SECONDS);
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
export async function firstContact<T extends { kind: string }>(
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
export async function outcomeFailure(
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
