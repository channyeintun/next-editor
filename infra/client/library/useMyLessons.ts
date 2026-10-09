import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { publishLesson, updateLessonName, updateLessonThumbnail } from "../upload/uploadLesson";
import { lessonKeys, playlistKeys } from "../../lessons/queryKeys";
import { deleteLesson, fetchMyLessons, unpublishLesson } from "./myLessonsApi";

export function useMyLessons() {
  return useQuery({
    queryKey: lessonKeys.mine,
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

// Playlist cards are derived from lessons: `lesson_count` follows the
// playlist_lessons cascade on delete, and the cover thumbnail comes from the
// playlist's first *published* member. Every lesson mutation therefore changes
// playlist-rendered data, and with `staleTime: Infinity` in queryClient a stale
// playlist card never refetches on its own — My Library would show the lesson
// disappear while the playlist beside it kept the old count and cover for the
// rest of the session. So the whole playlistKeys.all prefix goes stale too
// (`usePlaylists` already invalidates in the other direction).
//
// Exported for useUploadLesson too: a newly uploaded draft belongs in My
// Library the next time it mounts.
export function invalidateLessonDerivedQueries(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: lessonKeys.mine }),
    queryClient.invalidateQueries({ queryKey: playlistKeys.all }),
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
