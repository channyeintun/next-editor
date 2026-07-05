-- users.username: url-safe handle for public profile URLs (/learn/@username).
-- Nullable at the column level (SQLite can't ADD COLUMN ... UNIQUE NOT NULL
-- with existing rows in one step), but every row gets one via the backfill
-- below, and the unique index plus application-level generation (see
-- upsertUserByGoogleSub) keep it populated & unique from here on.
ALTER TABLE users ADD COLUMN username TEXT;

-- Deterministic backfill for existing rows: slugify name (or the email
-- local-part if name is unset) and suffix with the first 8 chars of the
-- user's uuid. The id suffix guarantees uniqueness without a procedural
-- dedup loop, which raw SQL can't express here.
UPDATE users
SET username = lower(
  replace(
    replace(
      coalesce(name, substr(email, 1, instr(email, '@') - 1)),
      ' ', '-'
    ),
    '.', '-'
  )
) || '-' || substr(id, 1, 8)
WHERE username IS NULL;

CREATE UNIQUE INDEX idx_users_username ON users(username);

-- Retroactively point existing lessons' author link at the owner's new
-- username, so old published lessons get a working author link too instead
-- of only lessons created after this migration.
UPDATE lessons
SET author_url = '/learn/@' || (SELECT username FROM users WHERE users.id = lessons.owner_id)
WHERE owner_id IN (SELECT id FROM users WHERE username IS NOT NULL);
