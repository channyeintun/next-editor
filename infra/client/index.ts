// Public exports for the host app.
export { default as AuthMenu } from "./auth/AuthMenu";
export { useAuth, useSignOut, signInUrl } from "./auth/useAuth";
export { default as UploadLessonModal } from "./upload/UploadLessonModal";
export type { UploadLessonModalProps } from "./upload/UploadLessonModal";
export { loadResumeIntent, clearResumeIntent } from "./upload/resumeIntent";
export type { ResumeIntent } from "./upload/resumeIntent";
export {
  useMyLessons,
  usePublishFromLibrary,
  useUnpublishLesson,
  useDeleteLesson,
} from "./library/useMyLessons";
export type { OwnedLesson } from "../db/types";
