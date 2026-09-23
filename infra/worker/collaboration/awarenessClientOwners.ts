import type { RoomSqliteStorage } from "./roomSqliteDocumentStore";

// A tab can sit disconnected, or failed until its user clicks Retry, for days,
// and Retry reuses its document's awareness client ID. Each connection's first
// awareness frame renews the entry.
const AWARENESS_CLIENT_OWNERSHIP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// The client picks its ID and the connection quota lives in memory, so this
// cap is what bounds the table: at most members × 16 rows.
const MAX_AWARENESS_CLIENTS_PER_MEMBER = 16;

/**
 * The member each awareness client ID in the room belongs to.
 *
 * Peers keep one awareness state per client ID, so the room lets only one open
 * socket publish each ID. That alone would let another member take the ID of a
 * member who is offline and keep them out when they reconnect with it; this
 * record gives the ID to the member who published it first.
 */
export class AwarenessClientOwners {
  private readonly storage: RoomSqliteStorage;

  constructor(storage: RoomSqliteStorage) {
    this.storage = storage;
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_awareness_clients (
        client_id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_collaboration_awareness_clients_user
        ON collaboration_awareness_clients(user_id, expires_at);
    `);
  }

  /**
   * Records or renews `clientId` as `userId`'s; false when it belongs to
   * another member. Only the member's most recently claimed IDs are kept.
   */
  claim(clientId: number, userId: string, now = Date.now()): boolean {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "DELETE FROM collaboration_awareness_clients WHERE expires_at <= ?",
        now,
      );
      const owner = this.storage.sql
        .exec<{ user_id: string }>(
          "SELECT user_id FROM collaboration_awareness_clients WHERE client_id = ?",
          clientId,
        )
        .toArray()[0];
      if (owner && owner.user_id !== userId) return false;
      this.storage.sql.exec(
        `INSERT INTO collaboration_awareness_clients (client_id, user_id, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET expires_at = excluded.expires_at`,
        clientId,
        userId,
        now + AWARENESS_CLIENT_OWNERSHIP_TTL_MS,
      );
      // The ID just claimed is always kept, even when others share its time.
      this.storage.sql.exec(
        `DELETE FROM collaboration_awareness_clients
         WHERE user_id = ? AND client_id <> ? AND client_id NOT IN (
           SELECT client_id FROM collaboration_awareness_clients
           WHERE user_id = ? AND client_id <> ?
           ORDER BY expires_at DESC
           LIMIT ?
         )`,
        userId,
        clientId,
        userId,
        clientId,
        MAX_AWARENESS_CLIENTS_PER_MEMBER - 1,
      );
      return true;
    });
  }
}
