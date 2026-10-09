import type { QueryClient } from "@tanstack/react-query";
import { lessonDetailQueryKey } from "../../src/shared/serverQueryState";
import type { Lesson } from "./types";

// React Query keys for lesson and playlist data. tube's public reads and
// infra's owner-scoped reads and mutations share one QueryClient, and the
// mutations reach tube's queries by key prefix (a playlist edit invalidates
// playlistKeys.all, which covers tube's playlistKeys.detail). A key renamed on
// one side alone would silently stop that invalidation, so both sides build
// their keys here.

export const lessonKeys = {
  /** The public gallery's pages (tube's useLessonsInfinite). */
  infinite: ["lessons", "infinite"] as const,
  /** The signed-in owner's lessons, drafts included (My Library). */
  mine: ["lessons", "mine"] as const,
  /** One lesson by slug. The edge render pre-fills it, so it lives with that
   *  contract in src/shared/serverQueryState.ts. */
  detail: lessonDetailQueryKey,
};

export const playlistKeys = {
  /** The prefix every playlist key below starts with: invalidating it reaches them all. */
  all: ["playlists"] as const,
  /** The signed-in owner's playlists (My Library). */
  mine: ["playlists", "mine"] as const,
  /** The owner's playlists, each marked with whether it holds this lesson. */
  forLesson: (lessonId: string | undefined) =>
    ["playlists", "mine", "for-lesson", lessonId] as const,
  /** The prefix every playlistKeys.members key starts with. */
  allMembers: ["playlists", "members"] as const,
  /** Every member of one of the owner's playlists, unpublished ones included. */
  members: (playlistId: string | undefined) => ["playlists", "members", playlistId] as const,
  /** One public playlist by slug (tube's usePlaylist). */
  detail: (slug: string | undefined) => ["playlists", "detail", slug] as const,
};

/**
 * Prefixes of the lesson and playlist queries holding the signed-in owner's own
 * data (drafts, private membership). Their keys carry no user id, so they are
 * dropped when the session ends or changes hands (clearOwnerScopedQueries in
 * infra/client/auth/useAuth.ts); playlistKeys.forLesson sits under
 * playlistKeys.mine.
 */
export const ownerScopedLessonQueryKeys = [
  lessonKeys.mine,
  playlistKeys.mine,
  playlistKeys.allMembers,
] as const;

/**
 * Seed the detail cache from a list that already carries whole Lesson objects.
 * Every card in the gallery or a playlist holds exactly what the detail route
 * asks for, so clicking one should resolve from cache rather than re-fetching
 * the row the list just downloaded. Called from the list query functions (not
 * during render) so it covers every card without per-card wiring.
 */
export function primeLessonDetails(queryClient: QueryClient, lessons: readonly Lesson[]): void {
  for (const lesson of lessons) {
    queryClient.setQueryData(lessonKeys.detail(lesson.slug), lesson);
  }
}
