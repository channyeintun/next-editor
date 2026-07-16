ALTER TABLE collaboration_rooms ADD COLUMN purged_at INTEGER;

CREATE TABLE collaboration_audit_events (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX idx_collaboration_audit_room
  ON collaboration_audit_events(room_id, created_at DESC);
