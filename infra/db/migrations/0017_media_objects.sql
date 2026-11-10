-- Every R2 object a signed-in user's upload or slide-image import stored
-- (worker/routes/uploads.ts, worker/routes/slideImages.ts), with its size.
-- The per-user storage quota (infra/db/mediaObjects.ts) is checked against
-- these rows inside the upsert that records a new one, so one account cannot
-- fill the shared bucket. A slide image is shared by every deck that uses it
-- and is charged to whoever stored it first. Objects stored before this table
-- existed are not listed, and count against nobody.
CREATE TABLE media_objects (
  key        TEXT PRIMARY KEY,               -- R2 key: lessons/<id>/<file> or slide-images/<hash>
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,               -- epoch ms
  updated_at INTEGER NOT NULL                -- epoch ms
);

-- Covers the quota's per-owner SUM and COUNT without reading the table.
CREATE INDEX idx_media_objects_owner ON media_objects(owner_id, bytes);
