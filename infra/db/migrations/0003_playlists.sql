-- playlists: always-public (no draft state), owner-curated ordered lists of
-- the owner's OWN lessons. Unlike lessons, there is no status column here —
-- a playlist is live at its slug as soon as it's created.
CREATE TABLE playlists (
  id          TEXT PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_playlists_owner ON playlists(owner_id, updated_at DESC);

-- playlist_lessons: ordered membership join table. position is a dense
-- 0-based integer, rewritten in full on reorder. A lesson can be unpublished
-- after being added here — callers must re-filter status='published' at read
-- time (see getPlaylistBySlug), this table alone doesn't guarantee that.
CREATE TABLE playlist_lessons (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  lesson_id   TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, lesson_id)
);

CREATE INDEX idx_playlist_lessons_order ON playlist_lessons(playlist_id, position);
