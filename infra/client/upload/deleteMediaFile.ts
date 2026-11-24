import { apiClient } from "../apiClient";

/**
 * Delete one narration file from a lesson's R2 folder. A lesson replaced in
 * place puts its new narration under a new name and then the .ne that names
 * it; the old narration is deleted last, once nothing points at it. The
 * Worker refuses any file that is not narration (routes/uploads.ts), and
 * answers a file that is already gone as deleted.
 */
export async function deleteLessonAudioFile(lessonId: string, filename: string): Promise<void> {
  await apiClient.delete(`/uploads/${lessonId}/media/${filename}`);
}
