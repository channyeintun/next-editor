import type { CaptionCue, Recording } from "@app/core/src";
import { buildRecordingFiles } from "@app/storage/RecordingStorage";
import { serializeCuesToVtt } from "@app/captions/serializeVtt";
import { apiClient } from "../apiClient";
import { DEFAULT_THUMBNAIL_PATH } from "../../lessons/defaultThumbnail";

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface UploadCaptionInput {
  /** Lowercase language tag (e.g. "en", "pt-br") — becomes the `<id>.<lang>.vtt` name suffix. */
  language: string;
  cues: CaptionCue[];
}

export interface UploadLessonInput {
  recording: Recording;
  title: string;
  description: string;
  tags: string[];
  thumbnail?: File;
  /** Use the built-in placeholder image instead of uploading one. Ignored if `thumbnail` is set. */
  useDefaultThumbnail?: boolean;
  /** Caption tracks uploaded as sibling `.vtt` files and declared in the `.ne`'s `captionFiles`. */
  captions?: UploadCaptionInput[];
}

export interface UploadedLesson {
  id: string;
  slug: string;
}

interface UploadTarget {
  filename: string;
  blob: Blob;
}

const THUMBNAIL_EXTENSIONS = ["png", "jpg", "jpeg"] as const;

// The upload route's filename allow-list only recognizes these extensions, so a name-derived
// guess (e.g. a phone photo like "IMG_1234.JPG") must be normalized against it — falling back
// to a mime-type guess, then "png", rather than ever forwarding an extension the route rejects.
// svg is deliberately not one of them — see worker/routes/uploads.ts.
export function thumbnailExtension(file: File): string {
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (fromName && (THUMBNAIL_EXTENSIONS as readonly string[]).includes(fromName)) {
    return fromName;
  }

  const fromMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
  };
  return fromMime[file.type] ?? "png";
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
      headers: {
        "Content-Type": target.blob.type || "application/octet-stream",
      },
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

  // Captions are canonicalized to WebVTT and named `<id>.<lang>.vtt` so the URL
  // loader can infer each track's language from the filename. Keyed by language —
  // duplicate tags would collide on the same R2 key, so the last one wins.
  const captionsByLanguage = new Map<string, UploadCaptionInput>();
  for (const caption of input.captions ?? []) {
    captionsByLanguage.set(caption.language.toLowerCase(), caption);
  }
  const captionTargets: UploadTarget[] = [...captionsByLanguage.entries()].map(
    ([language, caption]) => ({
      filename: `${lessonId}.${language}.vtt`,
      blob: new Blob([serializeCuesToVtt(caption.cues)], { type: "text/vtt" }),
    }),
  );

  const files = await buildRecordingFiles(
    input.recording,
    lessonId,
    captionTargets.length > 0
      ? { captionFiles: captionTargets.map((target) => target.filename) }
      : undefined,
  );

  const targets: UploadTarget[] = [{ filename: `${lessonId}.ne`, blob: files.ne }];
  if (files.audio) targets.push({ filename: files.audio.name, blob: files.audio.blob });
  if (files.camera) targets.push({ filename: files.camera.name, blob: files.camera.blob });
  targets.push(...captionTargets);
  const thumbnailFilename = input.thumbnail
    ? `${lessonId}-thumbnail.${thumbnailExtension(input.thumbnail)}`
    : null;
  if (input.thumbnail && thumbnailFilename) {
    targets.push({ filename: thumbnailFilename, blob: input.thumbnail });
  }

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

  const thumbnail = thumbnailFilename
    ? pathsByFilename[thumbnailFilename]
    : input.useDefaultThumbnail
      ? DEFAULT_THUMBNAIL_PATH
      : undefined;

  const res = await apiClient.post<{ id: string; slug: string }>("/lessons", {
    id: lessonId,
    title: input.title,
    description: input.description || undefined,
    tags: input.tags.length > 0 ? input.tags : undefined,
    duration: formatDuration(input.recording.duration),
    ne: pathsByFilename[`${lessonId}.ne`],
    thumbnail,
  });

  return { id: res.data.id, slug: res.data.slug };
}

export async function publishLesson(lessonId: string): Promise<void> {
  await apiClient.post(`/lessons/${lessonId}/publish`);
}

// A timestamp in the filename (rather than the fixed "<id>-thumbnail.<ext>"
// the initial upload uses) so a thumbnail change on an already-published
// lesson gets a fresh URL — reusing the old key would mean the CDN/browser
// keeps serving cached bytes from the previous image at that same path.
export async function updateLessonThumbnail(
  lessonId: string,
  thumbnail: File | "default",
): Promise<void> {
  let thumbnailPath: string;
  if (thumbnail === "default") {
    thumbnailPath = DEFAULT_THUMBNAIL_PATH;
  } else {
    const filename = `${lessonId}-thumbnail-${Date.now()}.${thumbnailExtension(thumbnail)}`;
    const res = await apiClient.put<{ path: string }>(
      `/uploads/${lessonId}/media/${filename}`,
      thumbnail,
      {
        headers: {
          "Content-Type": thumbnail.type || "application/octet-stream",
        },
      },
    );
    thumbnailPath = res.data.path;
  }
  await apiClient.patch(`/lessons/${lessonId}`, { thumbnail: thumbnailPath });
}

export async function updateLessonName(lessonId: string, title: string): Promise<void> {
  await apiClient.patch(`/lessons/${lessonId}`, { title });
}
