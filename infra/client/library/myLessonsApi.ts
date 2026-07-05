import { apiClient } from "../apiClient";
import type { OwnedLesson } from "../../db/types";

export async function fetchMyLessons(): Promise<OwnedLesson[]> {
  const res = await apiClient.get<{ lessons: OwnedLesson[] }>("/lessons/mine");
  return res.data.lessons;
}

export async function unpublishLesson(lessonId: string): Promise<void> {
  await apiClient.post(`/lessons/${lessonId}/unpublish`);
}

export async function deleteLesson(lessonId: string): Promise<void> {
  await apiClient.delete(`/lessons/${lessonId}`);
}
