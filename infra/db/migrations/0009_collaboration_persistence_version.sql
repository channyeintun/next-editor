-- Existing rooms keep the Redis-backed document log. New WebSocket rooms can
-- opt into the room Durable Object's private SQLite log without changing the
-- transport or attempting an in-place migration.
ALTER TABLE collaboration_rooms
  ADD COLUMN persistence_version INTEGER NOT NULL DEFAULT 1
  CHECK (persistence_version IN (1, 2));
