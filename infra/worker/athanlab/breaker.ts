/**
 * A global breaker on failed AthanLab authentications (the
 * provider_auth_breaker table, migrations/0015_athanlab_credentials.sql).
 *
 * To AthanLab every Next Editor user arrives from one shared Cloudflare
 * network, and AthanLab blocks a network for 10 minutes (`auth_blocked`) after
 * 20 failed authentications in 5 minutes, unknown and malformed keys
 * included. So one person pasting wrong keys, or a few expired keys, could
 * shut AthanLab off for everyone. This module bounds that from our side:
 *
 * - A key check (PUT /key) must first win a slot from reserveKeyCheck: one
 *   conditional upsert that counts the check as a failure in the current
 *   fixed 5-minute window before AthanLab hears of it, and only while the
 *   window holds fewer than KEY_CHECK_PAUSE_FAILURES. A check that ends on a
 *   definite answer other than 401 hands its slot back (refundKeyCheck); one
 *   AthanLab rejects keeps it as the recorded failure, and so does one whose
 *   call threw or timed out, since AthanLab may still have counted that key.
 *   Since the slot is taken before AthanLab
 *   is contacted, concurrent checks cannot overshoot, and since a check stops
 *   at its first 401, it fails at most once: at most 8 failed key checks are
 *   admitted per window, so at most 16 in any 5-minute span, below
 *   AthanLab's 20. Counting happens at admission; a check's 401 comes back
 *   while it runs (at most four calls of up to 15 s each), so it can land up
 *   to about a minute after the window it was counted in.
 * - A 401 for a stored key (recordAuthFailure) counts in the same window and
 *   pauses key checks sooner, but is not gated here: routes/athanlab.ts sends
 *   each stored key under a per-user first-contact lease tied to that sealed
 *   key, so a revoked key costs one failure however many requests carry it at
 *   once, even if the user replaces it meanwhile.
 * - An `auth_blocked` answer stops every AthanLab route until the block ends.
 *
 * Workers Rate Limiting cannot hold this: its counters are per location and
 * its periods stop at 60 seconds. A D1 failure here never breaks the request
 * that hit it: reads fall back to "not blocked", writes are logged and
 * dropped. The one exception is the reservation, which is the safety gate:
 * it reports the failure so PUT /key can refuse the check instead.
 */

const PROVIDER = "athanlab";
export const AUTH_FAILURE_WINDOW_MS = 5 * 60_000;
export const KEY_CHECK_PAUSE_FAILURES = 8;
// A Worker's clock only moves on I/O, so a request can arrive with a
// timestamp slightly older than the window a concurrent request just opened.
// That must not restart the window (it would wipe the slots counted in it);
// only a window stamped more than this far ahead, by a badly skewed clock,
// is restarted.
const CLOCK_SKEW_TOLERANCE_MS = 60_000;
const MIN_AUTH_BLOCK_MS = 60_000;
// AthanLab documents a 10-minute block; a longer Retry-After is honored up to
// an hour, so a garbled header cannot switch the provider off indefinitely.
const MAX_AUTH_BLOCK_MS = 60 * 60_000;

// True when the stored window no longer covers `excluded.window_started_at`
// (the caller's now): ?3 is AUTH_FAILURE_WINDOW_MS, ?4 the skew tolerance.
const WINDOW_ENDED = `(excluded.window_started_at >= provider_auth_breaker.window_started_at + ?3
    OR provider_auth_breaker.window_started_at > excluded.window_started_at + ?4)`;

export interface BreakerState {
  /** True while the current window already holds too many failed key checks. */
  keyChecksPaused: boolean;
  /** epoch ms until which AthanLab refuses our network; 0 when it does not. */
  blockedUntil: number;
}

interface BreakerRow {
  window_started_at: number;
  failures: number;
  blocked_until: number;
}

/**
 * A plain read, for failing fast. Under concurrency only reserveKeyCheck
 * decides whether a key check may run.
 */
export async function readBreaker(db: D1Database, now = Date.now()): Promise<BreakerState> {
  try {
    const row = await db
      .prepare(
        `SELECT window_started_at, failures, blocked_until
         FROM provider_auth_breaker WHERE provider = ?`,
      )
      .bind(PROVIDER)
      .first<BreakerRow>();
    if (!row) return { keyChecksPaused: false, blockedUntil: 0 };
    const inWindow =
      now < row.window_started_at + AUTH_FAILURE_WINDOW_MS &&
      row.window_started_at <= now + CLOCK_SKEW_TOLERANCE_MS;
    return {
      keyChecksPaused: inWindow && row.failures >= KEY_CHECK_PAUSE_FAILURES,
      blockedUntil: row.blocked_until > now ? row.blocked_until : 0,
    };
  } catch {
    console.error("AthanLab auth breaker could not be read");
    return { keyChecksPaused: false, blockedUntil: 0 };
  }
}

export type KeyCheckReservation =
  /** Admitted, and counted as a failure until refunded. */
  | { kind: "reserved"; windowStartedAt: number }
  /** The current window already holds KEY_CHECK_PAUSE_FAILURES. */
  | { kind: "paused" }
  | { kind: "blocked"; blockedUntil: number }
  /** D1 failed: the check must not run. */
  | { kind: "unavailable" };

/**
 * Admit one key check, counting it as a failed authentication before
 * AthanLab hears of it. One upsert decides: a window that has ended restarts
 * at `now` holding this check; otherwise the check is added only while the
 * window holds fewer than KEY_CHECK_PAUSE_FAILURES, and never while AthanLab
 * is blocking us. No returned row means it was refused.
 */
export async function reserveKeyCheck(
  db: D1Database,
  now = Date.now(),
): Promise<KeyCheckReservation> {
  let row: Pick<BreakerRow, "window_started_at" | "failures"> | null;
  try {
    row = await db
      .prepare(
        `INSERT INTO provider_auth_breaker (provider, window_started_at, failures, blocked_until)
         VALUES (?1, ?2, 1, 0)
         ON CONFLICT(provider) DO UPDATE SET
           failures = CASE WHEN ${WINDOW_ENDED} THEN 1
             ELSE provider_auth_breaker.failures + 1 END,
           window_started_at = CASE WHEN ${WINDOW_ENDED} THEN excluded.window_started_at
             ELSE provider_auth_breaker.window_started_at END
         WHERE (${WINDOW_ENDED} OR provider_auth_breaker.failures < ?5)
           AND provider_auth_breaker.blocked_until <= excluded.window_started_at
         RETURNING window_started_at, failures`,
      )
      .bind(
        PROVIDER,
        now,
        AUTH_FAILURE_WINDOW_MS,
        CLOCK_SKEW_TOLERANCE_MS,
        KEY_CHECK_PAUSE_FAILURES,
      )
      .first<Pick<BreakerRow, "window_started_at" | "failures">>();
  } catch {
    console.error("AthanLab key check could not be reserved");
    return { kind: "unavailable" };
  }
  if (row) return { kind: "reserved", windowStartedAt: row.window_started_at };
  const { blockedUntil } = await readBreaker(db, now);
  return blockedUntil > now ? { kind: "blocked", blockedUntil } : { kind: "paused" };
}

/**
 * Hand back the slot of a key check that ended without a 401. Only the window
 * it was counted in is touched: once that window has ended, the slot no
 * longer holds anything back.
 */
export async function refundKeyCheck(db: D1Database, windowStartedAt: number): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE provider_auth_breaker SET failures = MAX(failures - 1, 0)
         WHERE provider = ? AND window_started_at = ?`,
      )
      .bind(PROVIDER, windowStartedAt)
      .run();
  } catch {
    console.error("AthanLab key check slot could not be returned");
  }
}

/**
 * Count one failed authentication with a stored key (a key check's failure is
 * its reservation). A single upsert, so concurrent failures from different
 * isolates all land; a window that has ended (or one stamped far in the
 * future by a skewed clock) restarts at `now` with this failure.
 */
export async function recordAuthFailure(db: D1Database, now = Date.now()): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO provider_auth_breaker (provider, window_started_at, failures, blocked_until)
         VALUES (?1, ?2, 1, 0)
         ON CONFLICT(provider) DO UPDATE SET
           failures = CASE WHEN ${WINDOW_ENDED} THEN 1
             ELSE provider_auth_breaker.failures + 1 END,
           window_started_at = CASE WHEN ${WINDOW_ENDED} THEN excluded.window_started_at
             ELSE provider_auth_breaker.window_started_at END`,
      )
      .bind(PROVIDER, now, AUTH_FAILURE_WINDOW_MS, CLOCK_SKEW_TOLERANCE_MS)
      .run();
  } catch {
    console.error("AthanLab auth failure could not be recorded");
  }
}

/**
 * Stop every AthanLab route until AthanLab's block has ended: at least a
 * minute, longer when its Retry-After says so. Returns when that is.
 */
export async function recordAuthBlocked(
  db: D1Database,
  retryAfterSeconds: number | null,
  now = Date.now(),
): Promise<number> {
  const blockMs = Math.min(
    Math.max(MIN_AUTH_BLOCK_MS, (retryAfterSeconds ?? 0) * 1000),
    MAX_AUTH_BLOCK_MS,
  );
  const blockedUntil = now + blockMs;
  try {
    await db
      .prepare(
        `INSERT INTO provider_auth_breaker (provider, window_started_at, failures, blocked_until)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(provider) DO UPDATE SET
           blocked_until = MAX(provider_auth_breaker.blocked_until, excluded.blocked_until)`,
      )
      .bind(PROVIDER, now, blockedUntil)
      .run();
  } catch {
    console.error("AthanLab auth block could not be recorded");
  }
  return blockedUntil;
}
