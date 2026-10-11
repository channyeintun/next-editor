import { apiClient } from "../apiClient";

// One file's PUT into a lesson's R2 folder: the recording upload and My
// Library's "Update thumbnail" both send their files through it.
export interface UploadTarget {
  filename: string;
  blob: Blob;
}

export async function uploadFile(
  lessonId: string,
  target: UploadTarget,
  onLoaded: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await apiClient.put<{ path: string }>(
    `/uploads/${lessonId}/media/${target.filename}`,
    target.blob,
    {
      headers: {
        "Content-Type": target.blob.type || "application/octet-stream",
      },
      onUploadProgress: (event) => onLoaded(event.loaded),
      signal,
    },
  );
  return res.data.path;
}
