import type { RoomSqliteStorage } from "./roomSqliteDocumentStore";

/**
 * How long a claim to publish the purge holds off another publish while it is
 * in flight or has just failed; after it, a repeated close may try again.
 */
export const CLEANUP_CLAIM_HOLD_MS = 60_000;

/**
 * Whether a closed room's delayed purge job has been published, kept in the
 * room object's own storage (which the purge itself deletes).
 *
 * A repeated close republishes the purge so that one whose publish failed is
 * not lost, but it used to republish on every request, with no bound, from a
 * QStash budget that every room's purge shares. Now a close publishes only
 * when no publish is confirmed for this close and none was claimed within
 * CLEANUP_CLAIM_HOLD_MS.
 */
export class ClosedRoomCleanupLedger {
  private readonly storage: RoomSqliteStorage;

  constructor(storage: RoomSqliteStorage) {
    this.storage = storage;
  }

  /** True when the caller should publish the purge for the close at `closedAt` now. */
  claim(closedAt: number, now = Date.now()): boolean {
    this.ensureTable();
    return this.storage.transactionSync(() => {
      const row = this.storage.sql
        .exec<{ claimed_at: number; confirmed: number }>(
          "SELECT claimed_at, confirmed FROM collaboration_cleanup_schedule WHERE closed_at = ?",
          closedAt,
        )
        .toArray()[0];
      if (row && (row.confirmed === 1 || now - row.claimed_at < CLEANUP_CLAIM_HOLD_MS)) {
        return false;
      }
      this.storage.sql.exec(
        `INSERT INTO collaboration_cleanup_schedule (closed_at, claimed_at, confirmed)
         VALUES (?, ?, 0)
         ON CONFLICT(closed_at) DO UPDATE SET claimed_at = excluded.claimed_at`,
        closedAt,
        now,
      );
      return true;
    });
  }

  /** Records that the purge for the close at `closedAt` is published. */
  confirm(closedAt: number, now = Date.now()): void {
    this.ensureTable();
    this.storage.sql.exec(
      `INSERT INTO collaboration_cleanup_schedule (closed_at, claimed_at, confirmed)
       VALUES (?, ?, 1)
       ON CONFLICT(closed_at) DO UPDATE SET confirmed = 1`,
      closedAt,
      now,
    );
  }

  private ensureTable(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_cleanup_schedule (
        closed_at INTEGER PRIMARY KEY,
        claimed_at INTEGER NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0
      );
    `);
  }
}
