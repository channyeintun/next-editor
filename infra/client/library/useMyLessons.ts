import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { authorKeys, lessonKeys, playlistKeys, searchKeys } from "../../lessons/queryKeys";
import {
  deleteLesson,
  fetchMyLessons,
  publishLesson,
  unpublishLesson,
  updateLessonName,
  updateLessonThumbnail,
} from "./myLessonsApi";

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

// A lesson mutation (publish, unpublish, delete, rename, new thumbnail, upload)
// changes the row every query that shows the lesson renders, so all of them go
// stale. Inactive ones are only marked stale and refetch on the next visit.
//
// - The public gallery, each lesson's detail, author profiles and search
//   results keep fresh data for up to a minute, and primeLessonDetails marks
//   every listed lesson's detail fresh. Without this an author who unpublished
//   a lesson and opened /learn still saw it listed, and its page still opened.
// - Playlist cards are derived from lessons: `lesson_count` follows the
//   playlist_lessons cascade on delete, and the cover thumbnail comes from the
//   playlist's first *published* member. With `staleTime: Infinity` in
//   queryClient a stale playlist card never refetches on its own — My Library
//   would show the lesson disappear while the playlist beside it kept the old
//   count and cover for the rest of the session (`usePlaylists` already
//   invalidates in the other direction).
//
// Exported for useUploadLesson too: a newly uploaded draft belongs in My
// Library the next time it mounts.
export function invalidateLessonDerivedQueries(queryClient: QueryClient) {
  return Promise.all(
    [lessonKeys.all, authorKeys.all, searchKeys.all, playlistKeys.all].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );
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
