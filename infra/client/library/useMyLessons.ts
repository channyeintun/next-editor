import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publishLesson, updateLessonName, updateLessonThumbnail } from "../upload/uploadLesson";
import { deleteLesson, fetchMyLessons, unpublishLesson } from "./myLessonsApi";

const MY_LESSONS_QUERY_KEY = ["lessons", "mine"] as const;
// Playlist cards are derived from lessons: `lesson_count` follows the
// playlist_lessons cascade on delete, and the cover thumbnail comes from the
// playlist's first *published* member. Every lesson mutation below therefore
// changes playlist-rendered data, and with `staleTime: Infinity` in queryClient
// a stale playlist card never refetches on its own — My Library shows the lesson
// disappear while the playlist beside it keeps the old count and cover for the
// rest of the session. `usePlaylists` already invalidates in the other direction.
const PLAYLISTS_QUERY_KEY = ["playlists"] as const;

export function useMyLessons() {
  return useQuery({
    queryKey: MY_LESSONS_QUERY_KEY,
    queryFn: fetchMyLessons,
  });
}

// Each hook is meant to be called once per lesson card, not hoisted to the
// grid — that gives every card its own independent isPending/error state
// instead of one mutation shared (and blocking) across the whole list.
function useMyLessonMutation(mutationFn: (lessonId: string) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => invalidateLessonDerivedQueries(queryClient),
  });
}

function invalidateLessonDerivedQueries(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: MY_LESSONS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: PLAYLISTS_QUERY_KEY }),
  ]);
}

export function usePublishFromLibrary() {
  return useMyLessonMutation(publishLesson);
}

export function useUnpublishLesson() {
  return useMyLessonMutation(unpublishLesson);
}

export function useDeleteLesson() {
  return useMyLessonMutation(deleteLesson);
}

export function useUpdateThumbnail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lessonId, thumbnail }: { lessonId: string; thumbnail: File | "default" }) =>
      updateLessonThumbnail(lessonId, thumbnail),
    onSuccess: () => invalidateLessonDerivedQueries(queryClient),
  });
}

export function useUpdateLessonName() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lessonId, title }: { lessonId: string; title: string }) =>
      updateLessonName(lessonId, title),
    onSuccess: () => invalidateLessonDerivedQueries(queryClient),
  });
}
