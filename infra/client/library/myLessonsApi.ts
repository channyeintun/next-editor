import { apiClient } from "../apiClient";
import { uploadFile } from "../upload/uploadFile";
import type { OwnedLesson } from "../../db/types";
import { DEFAULT_THUMBNAIL_PATH } from "../../lessons/defaultThumbnail";
import { thumbnailExtension, thumbnailFilename } from "../../lessons/thumbnailFiles";

export async function fetchMyLessons(): Promise<OwnedLesson[]> {
  const res = await apiClient.get<{ lessons: OwnedLesson[] }>("/lessons/mine");
  return res.data.lessons;
}

export async function publishLesson(lessonId: string): Promise<void> {
  await apiClient.post(`/lessons/${lessonId}/publish`);
}

export async function unpublishLesson(lessonId: string): Promise<void> {
  await apiClient.post(`/lessons/${lessonId}/unpublish`);
}

export async function deleteLesson(lessonId: string): Promise<void> {
  await apiClient.delete(`/lessons/${lessonId}`);
}

// The replacement goes up under a new write-once name (thumbnailFiles.ts), so
// the lesson gets a fresh URL rather than browsers and the edge keeping the
// previous image's cached bytes at the old one.
export async function updateLessonThumbnail(
  lessonId: string,
  thumbnail: File | "default",
): Promise<void> {
  let thumbnailPath: string;
  if (thumbnail === "default") {
    thumbnailPath = DEFAULT_THUMBNAIL_PATH;
  } else {
    const filename = thumbnailFilename(lessonId, thumbnailExtension(thumbnail));
    thumbnailPath = await uploadFile(lessonId, { filename, blob: thumbnail }, () => {});
  }
  await apiClient.patch(`/lessons/${lessonId}`, { thumbnail: thumbnailPath });
}

export async function updateLessonName(lessonId: string, title: string): Promise<void> {
  await apiClient.patch(`/lessons/${lessonId}`, { title });
}
