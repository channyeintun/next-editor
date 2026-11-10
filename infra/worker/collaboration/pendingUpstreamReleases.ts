import * as z from "zod";
import type { RoomSqliteStorage } from "./roomSqliteDocumentStore";

/**
 * How long the voice object keeps retrying a release Realtime has not
 * confirmed. Well past the provider's ~30 s session recovery window, so a
 * member who briefly drops their PeerConnection around a removal cannot outlast
 * it; after this the provider's own garbage collection is all that is left.
 */
export const MAX_PENDING_RELEASE_AGE_MS = 10 * 60 * 1000;

const midsSchema = z.array(z.string());

export interface PendingUpstreamRelease {
  sfuSessionId: string;
  userId: string;
  mids: string[];
  queuedAt: number;
}

interface PendingReleaseRow {
  sfu_session_id: string;
  user_id: string;
  mids: string;
  queued_at: number;
}

/**
 * SFU tracks that retired voice connections still hold upstream, kept in the
 * voice object's storage until Realtime confirms each one closed.
 *
 * A retired socket's attachment was the only record of its session and mids,
 * and it is discarded at retire, so a close that failed could never be retried:
 * not by the owner repeating a removal, not by anything else. A removed member
 * whose client kept its PeerConnection open could keep receiving the audio it
 * had pulled.
 */
export class PendingUpstreamReleases {
  private readonly storage: RoomSqliteStorage;

  constructor(storage: RoomSqliteStorage) {
    this.storage = storage;
  }

  /** Adds `mids` to what is pending for `userId`'s `sfuSessionId`. */
  add(sfuSessionId: string, userId: string, mids: readonly string[], now = Date.now()): void {
    this.ensureTable();
    this.storage.transactionSync(() => {
      const existing = this.get(sfuSessionId);
      const merged = [...new Set([...(existing?.mids ?? []), ...mids])];
      this.storage.sql.exec(
        `INSERT INTO collaboration_voice_pending_releases (sfu_session_id, user_id, mids, queued_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(sfu_session_id) DO UPDATE SET mids = excluded.mids`,
        sfuSessionId,
        userId,
        JSON.stringify(merged),
        now,
      );
    });
  }

  /** What is pending for `sfuSessionId`, or null when nothing is. */
  get(sfuSessionId: string): PendingUpstreamRelease | null {
    this.ensureTable();
    const row = this.storage.sql
      .exec<PendingReleaseRow>(
        "SELECT * FROM collaboration_voice_pending_releases WHERE sfu_session_id = ?",
        sfuSessionId,
      )
      .toArray()[0];
    return row ? toRelease(row) : null;
  }

  /** Every SFU session with tracks still pending, or only `userId`'s. */
  sessionIds(userId?: string): string[] {
    this.ensureTable();
    const rows =
      userId === undefined
        ? this.storage.sql.exec<{ sfu_session_id: string }>(
            "SELECT sfu_session_id FROM collaboration_voice_pending_releases",
          )
        : this.storage.sql.exec<{ sfu_session_id: string }>(
            "SELECT sfu_session_id FROM collaboration_voice_pending_releases WHERE user_id = ?",
            userId,
          );
    return rows.toArray().map((row) => row.sfu_session_id);
  }

  /** Drops the `mids` Realtime confirmed closed; mids added since stay pending. */
  settle(sfuSessionId: string, mids: readonly string[]): void {
    this.storage.transactionSync(() => {
      const existing = this.get(sfuSessionId);
      if (!existing) return;
      const closed = new Set(mids);
      const remaining = existing.mids.filter((mid) => !closed.has(mid));
      if (remaining.length === 0) {
        this.storage.sql.exec(
          "DELETE FROM collaboration_voice_pending_releases WHERE sfu_session_id = ?",
          sfuSessionId,
        );
        return;
      }
      this.storage.sql.exec(
        "UPDATE collaboration_voice_pending_releases SET mids = ? WHERE sfu_session_id = ?",
        JSON.stringify(remaining),
        sfuSessionId,
      );
    });
  }

  /** Removes and returns releases queued more than MAX_PENDING_RELEASE_AGE_MS ago. */
  expire(now = Date.now()): PendingUpstreamRelease[] {
    this.ensureTable();
    return this.storage.sql
      .exec<PendingReleaseRow>(
        "DELETE FROM collaboration_voice_pending_releases WHERE queued_at <= ? RETURNING *",
        now - MAX_PENDING_RELEASE_AGE_MS,
      )
      .toArray()
      .map(toRelease);
  }

  private ensureTable(): void {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_voice_pending_releases (
        sfu_session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        mids TEXT NOT NULL,
        queued_at INTEGER NOT NULL
      );
    `);
  }
}

function toRelease(row: PendingReleaseRow): PendingUpstreamRelease {
  const mids = midsSchema.safeParse(JSON.parse(row.mids));
  return {
    sfuSessionId: row.sfu_session_id,
    userId: row.user_id,
    mids: mids.success ? mids.data : [],
    queuedAt: row.queued_at,
  };
}
