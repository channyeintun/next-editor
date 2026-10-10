import { publishedPlaylistsByOwnerStatement } from "./playlistQueries";
import { publishedLessonsByOwnerStatement } from "./queries";
import type { LessonRow, PlaylistRowWithCount, UserRow } from "./types";

export interface PublishedAuthorProfile {
  user: UserRow;
  lessons: LessonRow[];
  playlists: PlaylistRowWithCount[];
}

// Backs the public author profile (/learn/@username for anyone but the owner):
// the user with their published lessons and playlists, read in one batch (one
// round trip, from one snapshot) by keying the two lists on the username
// rather than waiting for the user's id. The lookup is an exact match, so
// usernames from before USERNAME_PATTERN keep resolving. null when no user has
// that username.
export async function getPublishedAuthorProfile(
  db: D1Database,
  username: string,
): Promise<PublishedAuthorProfile | null> {
  const [userResult, lessonsResult, playlistsResult] = await db.batch([
    db.prepare("SELECT * FROM users WHERE username = ?").bind(username),
    publishedLessonsByOwnerStatement(db, { username }),
    publishedPlaylistsByOwnerStatement(db, { username }),
  ]);
  const user = userResult.results?.[0] as UserRow | undefined;
  if (!user) return null;

  return {
    user,
    lessons: (lessonsResult.results ?? []) as LessonRow[],
    playlists: (playlistsResult.results ?? []) as PlaylistRowWithCount[],
  };
}
