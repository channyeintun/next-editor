import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { uploadLesson, publishLesson, type UploadLessonInput } from "./uploadLesson";

export { formatDuration } from "./uploadLesson";
export type { UploadLessonInput, UploadedLesson } from "./uploadLesson";

export function useUploadLesson() {
  const [progress, setProgress] = useState(0);
  // React Query does not abort a mutation when its component unmounts, and the
  // upload is a plain sequential promise chain — so closing the modal used to
  // leave the remaining PUTs streaming into R2 and the final POST /lessons still
  // creating the draft row the user had just declined. `cancel` is what makes
  // "Cancel upload" actually cancel.
  const controllerRef = useRef<AbortController | null>(null);

  const mutation = useMutation({
    mutationFn: ({ lessonId, input }: { lessonId: string; input: UploadLessonInput }) => {
      const controller = new AbortController();
      controllerRef.current = controller;
      return uploadLesson(lessonId, input, setProgress, controller.signal);
    },
  });

  return {
    upload: mutation.mutateAsync,
    cancel: () => controllerRef.current?.abort(),
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
