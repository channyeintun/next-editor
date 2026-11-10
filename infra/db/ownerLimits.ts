// How many rows of each kind one user may hold in the shared D1 database.
// Any Google account can sign in, and every user shares one database, so a
// kind of row a user creates at will is capped per owner inside the INSERT
// that creates it (as MAX_ACTIVE_ROOMS_PER_OWNER caps collaboration rooms in
// collaborationQueries.ts): without one, a single account could grow D1 to its
// size limit, after which every write fails for everyone. Each cap sits far
// above what an author actually keeps; raise it here when one gets close.

/** Lessons, drafts and published alike (insertDraftLesson in queries.ts). */
export const MAX_LESSONS_PER_OWNER = 2_000;

/** Playlists (insertPlaylist in playlistQueries.ts). */
export const MAX_PLAYLISTS_PER_OWNER = 200;

/**
 * Live sessions, one per signed-in browser (createSession in queries.ts): a
 * new sign-in past this ends that user's oldest session.
 */
export const MAX_LIVE_SESSIONS_PER_USER = 20;

/**
 * R2 storage one user's lesson uploads and slide-image imports may hold
 * (media_objects, see mediaObjects.ts): bytes, and objects. A lesson is a
 * handful of objects (its .ne, audio, camera video, thumbnail, captions).
 */
export const MAX_MEDIA_BYTES_PER_OWNER = 25 * 1024 ** 3;
export const MAX_MEDIA_OBJECTS_PER_OWNER = 20_000;
