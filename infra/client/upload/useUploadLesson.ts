import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { uploadLesson, publishLesson, type UploadLessonInput } from "./uploadLesson";

export { formatDuration } from "./uploadLesson";
export type { UploadLessonInput, UploadedLesson } from "./uploadLesson";

export function useUploadLesson() {
  const [progress, setProgress] = useState(0);

  const mutation = useMutation({
    mutationFn: ({ lessonId, input }: { lessonId: string; input: UploadLessonInput }) =>
      uploadLesson(lessonId, input, setProgress),
  });

  return {
    upload: mutation.mutateAsync,
    progress,
    isUploading: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}

export function usePublishLesson() {
  return useMutation({
    mutationFn: (lessonId: string) => publishLesson(lessonId),
  });
}
