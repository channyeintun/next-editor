import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publishLesson, updateLessonName, updateLessonThumbnail } from "../upload/uploadLesson";
import { deleteLesson, fetchMyLessons, unpublishLesson } from "./myLessonsApi";

const MY_LESSONS_QUERY_KEY = ["lessons", "mine"] as const;

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MY_LESSONS_QUERY_KEY }),
  });
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MY_LESSONS_QUERY_KEY }),
  });
}

export function useUpdateLessonName() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lessonId, title }: { lessonId: string; title: string }) =>
      updateLessonName(lessonId, title),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MY_LESSONS_QUERY_KEY }),
  });
}
