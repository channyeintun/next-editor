-- Room documents use the Durable Object's private SQLite log.
ALTER TABLE collaboration_rooms
  ADD COLUMN persistence_version INTEGER NOT NULL DEFAULT 2
  CHECK (persistence_version = 2);
