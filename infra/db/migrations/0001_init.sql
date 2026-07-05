-- users: one row per Google identity
CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- internal uuid
  google_sub  TEXT UNIQUE NOT NULL,      -- Google "sub" claim (stable id)
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  avatar_url  TEXT,
  created_at  INTEGER NOT NULL           -- epoch ms
);

-- sessions: server-side session store keyed by an opaque cookie token
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,          -- random 256-bit token (the cookie value)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- lessons: user-generated only. The seed (introduction) is NOT in D1.
CREATE TABLE lessons (
  id            TEXT PRIMARY KEY,        -- uuid; also the R2 folder + slug base
  slug          TEXT UNIQUE NOT NULL,    -- url-safe; "<kebab-title>-<short-id>"
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT,
  thumbnail     TEXT,                    -- same-origin path, e.g. /media/lessons/<id>/thumbnail.png
  ne            TEXT NOT NULL,           -- same-origin path, e.g. /media/lessons/<id>/<id>.ne
  duration      TEXT,                    -- "4:12" (display string, matches Lesson type)
  tags          TEXT,                    -- JSON array string
  author        TEXT,                    -- denormalized display name (from users.name)
  author_url    TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'published'
  published_at  INTEGER,                 -- set on publish; NULL while draft
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_lessons_published ON lessons(status, published_at DESC);
CREATE INDEX idx_lessons_owner     ON lessons(owner_id, updated_at DESC);
