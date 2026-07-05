import type { Recording } from "@app/core/src";
import { buildRecordingFiles } from "@app/storage/RecordingStorage";
import { apiClient } from "../apiClient";

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface UploadLessonInput {
  recording: Recording;
  title: string;
  description: string;
  tags: string[];
}

export interface UploadedLesson {
  id: string;
  slug: string;
}

interface UploadTarget {
  filename: string;
  blob: Blob;
}

async function uploadFile(
  lessonId: string,
  target: UploadTarget,
  onLoaded: (loaded: number) => void,
): Promise<string> {
  const res = await apiClient.put<{ path: string }>(
    `/uploads/${lessonId}/media/${target.filename}`,
    target.blob,
    {
      headers: { "Content-Type": target.blob.type || "application/octet-stream" },
      onUploadProgress: (event) => onLoaded(event.loaded),
    },
  );
  return res.data.path;
}

// Uploads .ne + audio/camera (if present) sequentially, then creates the D1
// draft row. Sequential (not parallel) keeps the combined progress bar's math
// simple and matches the spec's "single progress bar, not per-file" — the
// user doesn't care which file is moving. The lesson id is generated once by
// the caller (useState in the modal) and reused across retries, so a retry
// re-PUTs to the same R2 keys rather than starting a new lesson cold.
export async function uploadLesson(
  lessonId: string,
  input: UploadLessonInput,
  onProgress: (progress: number) => void,
): Promise<UploadedLesson> {
  onProgress(0);
  const files = await buildRecordingFiles(input.recording, lessonId);

  const targets: UploadTarget[] = [{ filename: `${lessonId}.ne`, blob: files.ne }];
  if (files.audio) targets.push({ filename: files.audio.name, blob: files.audio.blob });
  if (files.camera) targets.push({ filename: files.camera.name, blob: files.camera.blob });

  const totalBytes = targets.reduce((sum, target) => sum + target.blob.size, 0) || 1;
  const loadedByIndex = Array.from<number>({ length: targets.length }).fill(0);

  const pathsByFilename: Record<string, string> = {};
  for (const [index, target] of targets.entries()) {
    pathsByFilename[target.filename] = await uploadFile(lessonId, target, (loaded) => {
      loadedByIndex[index] = loaded;
      const totalLoaded = loadedByIndex.reduce((sum, value) => sum + value, 0);
      onProgress(Math.min(1, totalLoaded / totalBytes));
    });
  }

  const res = await apiClient.post<{ id: string; slug: string }>("/lessons", {
    id: lessonId,
    title: input.title,
    description: input.description || undefined,
    tags: input.tags.length > 0 ? input.tags : undefined,
    duration: formatDuration(input.recording.duration),
    ne: pathsByFilename[`${lessonId}.ne`],
  });

  return { id: res.data.id, slug: res.data.slug };
}

export async function publishLesson(lessonId: string): Promise<void> {
  await apiClient.post(`/lessons/${lessonId}/publish`);
}
