CREATE TABLE collaboration_assets (
  room_id     TEXT NOT NULL REFERENCES collaboration_rooms(id) ON DELETE CASCADE,
  asset_id    TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK (size > 0),
  mime_type   TEXT NOT NULL,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (room_id, asset_id)
);

CREATE INDEX idx_collaboration_assets_room_created
  ON collaboration_assets(room_id, created_at);
