-- Moves rows off slugs that no URL can reach. slug.ts now refuses to hand these
-- out, but that only guards new rows; a row that got one earlier is stranded:
--
--   'mine'          Both routers register GET /mine (the owner's library)
--                   before GET /:slug, and Hono dispatches in registration
--                   order, so the API never serves a lesson or playlist
--                   with this slug.
--   'introduction'  Both lesson resolvers check the build-time seed before D1,
--                   so the built-in tour is served in place of a lesson that
--                   holds the seed's slug. Playlists have no seed, so a
--                   playlist keeps it.
--
-- Each such row moves to '<slug>-<first 8 chars of its id>', the shape of every
-- pre-2026-07 slug (see 0001_init.sql). The id prefix makes it unique without a
-- probe loop, which raw SQL can't express; should a row somehow hold that slug
-- already, the UNIQUE constraint aborts the migration rather than losing a row.
-- updated_at is left alone: this is not an owner edit, and owners' libraries
-- are ordered by it. When no row holds such a slug, nothing matches and nothing
-- changes.
UPDATE lessons
SET slug = slug || '-' || substr(id, 1, 8)
WHERE slug IN ('mine', 'introduction');

UPDATE playlists
SET slug = slug || '-' || substr(id, 1, 8)
WHERE slug = 'mine';
