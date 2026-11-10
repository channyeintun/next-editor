import { MAX_MEDIA_BYTES_PER_OWNER, MAX_MEDIA_OBJECTS_PER_OWNER } from "./ownerLimits";

/**
 * The R2 objects signed-in users stored through the upload and slide-image
 * routes (migrations/0017_media_objects.sql), and the per-user storage quota
 * checked against them: MAX_MEDIA_BYTES_PER_OWNER and
 * MAX_MEDIA_OBJECTS_PER_OWNER (ownerLimits.ts). A route records an object
 * (reserveMediaObject) before it writes the bytes, hands the reservation back
 * if the write fails (releaseMediaObject), and forgets objects it deletes.
 */

export type MediaObjectReservation =
  /** Admitted. `previousBytes` is what the key held before, or null for a new one. */
  | { kind: "reserved"; previousBytes: number | null }
  /** The owner's other objects plus this one would pass the quota. */
  | { kind: "over_quota" }
  /** Another user recorded this key first. */
  | { kind: "taken" };

/**
 * Record that `ownerId` is about to store `bytes` at `key`. One conditional
 * upsert admits it only while the owner's other objects plus this one stay
 * within the quota, so concurrent uploads cannot pass it together; storing a
 * key again replaces its size rather than adding to it. A key another user
 * recorded is never re-assigned.
 */
export async function reserveMediaObject(
  db: D1Database,
  key: string,
  ownerId: string,
  bytes: number,
  now = Date.now(),
): Promise<MediaObjectReservation> {
  const previous = await db
    .prepare("SELECT owner_id, bytes FROM media_objects WHERE key = ?")
    .bind(key)
    .first<{ owner_id: string; bytes: number }>();
  if (previous && previous.owner_id !== ownerId) return { kind: "taken" };

  const row = await db
    .prepare(
      `INSERT INTO media_objects (key, owner_id, bytes, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?4
       WHERE (SELECT COALESCE(SUM(bytes), 0) FROM media_objects
              WHERE owner_id = ?2 AND key <> ?1) + ?3 <= ?5
         AND (SELECT COUNT(*) FROM media_objects WHERE owner_id = ?2 AND key <> ?1) < ?6
       ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at
         WHERE media_objects.owner_id = excluded.owner_id
       RETURNING key`,
    )
    .bind(key, ownerId, bytes, now, MAX_MEDIA_BYTES_PER_OWNER, MAX_MEDIA_OBJECTS_PER_OWNER)
    .first();
  if (row) return { kind: "reserved", previousBytes: previous?.bytes ?? null };
  // Refused: over the quota, unless someone else recorded the key meanwhile.
  const holder = await db
    .prepare("SELECT owner_id FROM media_objects WHERE key = ?")
    .bind(key)
    .first<{ owner_id: string }>();
  return holder && holder.owner_id !== ownerId ? { kind: "taken" } : { kind: "over_quota" };
}

/**
 * Hand back a reservation whose write failed: R2 still holds what the key held
 * before (`previousBytes`, from the reservation), or nothing.
 */
export async function releaseMediaObject(
  db: D1Database,
  key: string,
  ownerId: string,
  previousBytes: number | null,
): Promise<void> {
  await (
    previousBytes === null
      ? db.prepare("DELETE FROM media_objects WHERE key = ? AND owner_id = ?").bind(key, ownerId)
      : db
          .prepare("UPDATE media_objects SET bytes = ? WHERE key = ? AND owner_id = ?")
          .bind(previousBytes, key, ownerId)
  ).run();
}

/** Forget one of the owner's objects, once it is deleted from R2. */
export async function forgetMediaObject(
  db: D1Database,
  key: string,
  ownerId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM media_objects WHERE key = ? AND owner_id = ?")
    .bind(key, ownerId)
    .run();
}

/**
 * Forget every one of the owner's objects whose key starts with `prefix`
 * (ending in "/"), once they are deleted from R2. A range, not LIKE: a lesson
 * id may contain "_", which LIKE reads as a wildcard.
 */
export async function forgetMediaObjectsUnder(
  db: D1Database,
  prefix: string,
  ownerId: string,
): Promise<void> {
  if (!prefix.endsWith("/")) throw new Error("forgetMediaObjectsUnder: prefix must end in '/'");
  // Every key under "<prefix>" sorts below "<prefix minus its slash>0" ('0' follows '/').
  const end = `${prefix.slice(0, -1)}0`;
  await db
    .prepare("DELETE FROM media_objects WHERE owner_id = ? AND key >= ? AND key < ?")
    .bind(ownerId, prefix, end)
    .run();
}
