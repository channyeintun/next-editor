-- Collaboration control plane. Live Yjs updates are stored in each room's
-- Durable Object SQLite database, not in D1.
CREATE TABLE collaboration_rooms (
  id                      TEXT PRIMARY KEY,
  owner_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                  TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'closed', 'failed')),
  protocol_version        INTEGER NOT NULL,
  document_schema_version INTEGER NOT NULL,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  closed_at               INTEGER
);

CREATE INDEX idx_collaboration_rooms_owner
  ON collaboration_rooms(owner_id, updated_at DESC);

CREATE TABLE collaboration_members (
  room_id    TEXT NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX idx_collaboration_members_user
  ON collaboration_members(user_id, updated_at DESC);
