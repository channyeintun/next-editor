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
