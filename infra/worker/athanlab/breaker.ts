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
 *   transaction that counts the check as a failure in the current fixed
 *   5-minute window before AthanLab hears of it, and only while the window
 *   holds fewer than KEY_CHECK_PAUSE_FAILURES and fewer than
 *   KEY_CHECK_SLOTS_PER_USER of the same user's checks
 *   (provider_key_check_shares, migrations/0016_athanlab_key_check_shares.sql),
 *   so one account sending bogus keys cannot take every slot and pause key
 *   checks for everyone else. A check that ends on a
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
 *   pauses key checks sooner, but is not gated here: storedKey.ts makes
 *   every call with a stored key under a per-user lease tied to that sealed
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
// One user's share of those slots: it takes several accounts, not one, to fill
// a window, and someone who pastes a wrong key once still has a try left.
export const KEY_CHECK_SLOTS_PER_USER = 2;
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
// The same test inside reserveKeyCheck's share statement, on the breaker row
// in scope there: ?4 is the caller's now, ?5 AUTH_FAILURE_WINDOW_MS, ?6 the
// skew tolerance.
const SHARE_WINDOW_ENDED = `(?4 >= window_started_at + ?5 OR window_started_at > ?4 + ?6)`;
// True when this check's share was taken: ?6 is the user, ?7 the reservation.
const SHARE_TAKEN = `EXISTS (SELECT 1 FROM provider_key_check_shares
    WHERE provider = ?1 AND user_id = ?6 AND reservation = ?7)`;

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
 * Admit one key check for `userId`, counting it as a failed authentication
 * before AthanLab hears of it. One transaction decides. The user's share is
 * taken first, and only while the window this check would be counted in (the
 * current one, or one starting at `now` once it has ended) holds fewer than
 * KEY_CHECK_PAUSE_FAILURES, AthanLab is not blocking us, and that window holds
 * fewer than KEY_CHECK_SLOTS_PER_USER of this user's checks. The global slot
 * is then taken only for a check whose share was just taken (the share row
 * names its reservation), under the same conditions. No returned row means it
 * was refused.
 */
export async function reserveKeyCheck(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<KeyCheckReservation> {
  const reservation = crypto.randomUUID();
  let row: Pick<BreakerRow, "window_started_at" | "failures"> | undefined;
  try {
    const [, slot] = await db.batch([
      db
        .prepare(
          `INSERT INTO provider_key_check_shares (provider, user_id, window_started_at, slots, reservation)
           SELECT ?1, ?2, w.started_at, 1, ?3
           FROM (SELECT COALESCE(
             (SELECT CASE WHEN ${SHARE_WINDOW_ENDED} THEN ?4 ELSE window_started_at END
              FROM provider_auth_breaker WHERE provider = ?1),
             ?4) AS started_at) AS w
           WHERE NOT EXISTS (
             SELECT 1 FROM provider_auth_breaker
             WHERE provider = ?1
               AND (blocked_until > ?4 OR (failures >= ?7 AND NOT ${SHARE_WINDOW_ENDED})))
           ON CONFLICT(provider, user_id) DO UPDATE SET
             slots = CASE WHEN provider_key_check_shares.window_started_at = excluded.window_started_at
               THEN provider_key_check_shares.slots + 1 ELSE 1 END,
             window_started_at = excluded.window_started_at,
             reservation = excluded.reservation
           WHERE provider_key_check_shares.window_started_at <> excluded.window_started_at
             OR provider_key_check_shares.slots < ?8`,
        )
        .bind(
          PROVIDER,
          userId,
          reservation,
          now,
          AUTH_FAILURE_WINDOW_MS,
          CLOCK_SKEW_TOLERANCE_MS,
          KEY_CHECK_PAUSE_FAILURES,
          KEY_CHECK_SLOTS_PER_USER,
        ),
      db
        .prepare(
          `INSERT INTO provider_auth_breaker (provider, window_started_at, failures, blocked_until)
           SELECT ?1, ?2, 1, 0 WHERE ${SHARE_TAKEN}
           ON CONFLICT(provider) DO UPDATE SET
             failures = CASE WHEN ${WINDOW_ENDED} THEN 1
               ELSE provider_auth_breaker.failures + 1 END,
             window_started_at = CASE WHEN ${WINDOW_ENDED} THEN excluded.window_started_at
               ELSE provider_auth_breaker.window_started_at END
           WHERE (${WINDOW_ENDED} OR provider_auth_breaker.failures < ?5)
             AND provider_auth_breaker.blocked_until <= excluded.window_started_at
             AND ${SHARE_TAKEN}
           RETURNING window_started_at, failures`,
        )
        .bind(
          PROVIDER,
          now,
          AUTH_FAILURE_WINDOW_MS,
          CLOCK_SKEW_TOLERANCE_MS,
          KEY_CHECK_PAUSE_FAILURES,
          userId,
          reservation,
        ),
    ]);
    row = slot.results?.[0] as Pick<BreakerRow, "window_started_at" | "failures"> | undefined;
  } catch {
    console.error("AthanLab key check could not be reserved");
    return { kind: "unavailable" };
  }
  if (row) return { kind: "reserved", windowStartedAt: row.window_started_at };
  // Refused: AthanLab is blocking us, the window is full, or this user already
  // holds their share of it. The last two answer alike.
  const { blockedUntil } = await readBreaker(db, now);
  return blockedUntil > now ? { kind: "blocked", blockedUntil } : { kind: "paused" };
}

/**
 * Hand back the slot of a key check that ended without a 401, and its user's
 * share of it. Only the window it was counted in is touched: once that window
 * has ended, the slot no longer holds anything back.
 */
export async function refundKeyCheck(
  db: D1Database,
  userId: string,
  windowStartedAt: number,
): Promise<void> {
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE provider_auth_breaker SET failures = MAX(failures - 1, 0)
           WHERE provider = ? AND window_started_at = ?`,
        )
        .bind(PROVIDER, windowStartedAt),
      db
        .prepare(
          `UPDATE provider_key_check_shares SET slots = MAX(slots - 1, 0)
           WHERE provider = ? AND user_id = ? AND window_started_at = ?`,
        )
        .bind(PROVIDER, userId, windowStartedAt),
    ]);
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
