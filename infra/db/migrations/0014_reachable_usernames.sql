-- Rewrites the backfilled usernames whose profile URL the characters below
-- keep from loading. 0002 built usernames from the Google display name (or the
-- email's local part) and replaced only ' ' and '.', so every other character
-- of the name survived.
-- Every link to a profile is '/learn/@<username>', built without encoding, and
-- some of those characters break it:
--
--   '/' '\'  split the path in two (browsers read '\' as '/'), and the one
--            /learn/:slug route matches a single segment.
--   '?' '#'  end the path, so the router sees a shorter, different name.
--   '%'      when it starts an ASCII escape (%00-%7f), the router decodes it
--            into a different name: '50%50' becomes '50P'. The router decodes
--            the whole path or none of it, so a rare name that also holds a
--            malformed escape loads as written; this renames it too, harmlessly.
--
-- Those profiles never loaded, for visitors following an author link or for
-- the owner, whose My Library and username editor live on that page. This
-- replaces those characters with '-'. Each such row still ends in 0002's
-- '-<first 8 chars of id>' suffix, so the results stay distinct; should one
-- clash anyway, the unique index fails this migration instead of merging two
-- accounts. Names generated or chosen since 0002 use only [a-z0-9-], so no
-- other row matches. A bare '%', as in '100%-sure', starts no escape, routes as
-- written and is left alone. When no row matches, nothing changes.
--
-- SQLite string literals and GLOB classes have no escape character: each '\'
-- below is one literal backslash.
UPDATE users
SET username = replace(replace(replace(replace(replace(
  username, '/', '-'), '\', '-'), '?', '-'), '#', '-'), '%', '-')
WHERE username GLOB '*[/\?#]*' OR username GLOB '*%[0-7][0-9a-fA-F]*';

-- Points those users' lessons at the new name, as updateUsername's cascade
-- does on a rename. It runs second so that the one statement that can fail,
-- the rename above, does so before anything has changed.
UPDATE lessons
SET author_url = '/learn/@' || (SELECT username FROM users WHERE users.id = lessons.owner_id)
WHERE author_url GLOB '/learn/@*[/\?#]*' OR author_url GLOB '/learn/@*%[0-7][0-9a-fA-F]*';
