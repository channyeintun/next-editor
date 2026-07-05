import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { ImagePlus, X } from "lucide-react";
import type { Recording } from "@app/core/src";
import { copyTextToClipboard } from "@app/components/fileSidebarHelpers";
import { useAuth, signInUrl } from "../auth/useAuth";
import { useUploadLesson, usePublishLesson, formatDuration } from "./useUploadLesson";
import { saveResumeIntent } from "./resumeIntent";

const THUMBNAIL_ACCEPT = "image/png,image/jpeg,image/svg+xml";
// Keeps the upload PUT snappy and R2 tidy — generous for a thumbnail image.
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

export interface UploadLessonModalProps {
  recording: Recording;
  onClose: () => void;
  /** Restored after a "session expired mid-form" round trip (see the UX spec) —
   *  the one case where typed values cross the OAuth redirect. */
  initialTitle?: string;
  initialDescription?: string;
  initialTags?: string;
}

function defaultTitle(createdAt: number): string {
  const date = new Date(createdAt);
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `Recording — ${day}, ${time}`;
}

function parseTags(input: string): string[] {
  return input
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

// NOTE (deviation from the approved UX spec's stated default): "auto-generate
// a thumbnail from a recording frame" isn't straightforward here — a
// recording is code-diff/cursor state, not a video, so there's no simple
// frame to grab without a camera track (which is optional and often absent).
// v1 ships with a manual "select thumbnail" upload instead of a generated one.
// Flagged in docs/progress.md.
export default function UploadLessonModal({
  recording,
  onClose,
  initialTitle,
  initialDescription,
  initialTags,
}: UploadLessonModalProps) {
  const { isSignedIn, isLoading: authLoading } = useAuth();
  const [title, setTitle] = useState(initialTitle ?? defaultTitle(recording.createdAt));
  const [description, setDescription] = useState(initialDescription ?? "");
  const [tagsInput, setTagsInput] = useState(initialTags ?? "");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [lessonId] = useState(() => crypto.randomUUID());
  const [uploadResult, setUploadResult] = useState<{ id: string; slug: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
  const [thumbnailPreviewUrl, setThumbnailPreviewUrl] = useState<string | null>(null);
  const [useDefaultThumbnail, setUseDefaultThumbnail] = useState(false);
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const thumbnailInputRef = useRef<HTMLInputElement | null>(null);

  const { upload, progress, isUploading, error, reset } = useUploadLesson();
  const publish = usePublishLesson();

  // Revoke the preview's object URL whenever it's replaced/cleared or the modal unmounts,
  // so a large image doesn't linger in memory past the form that offered it.
  useEffect(() => {
    return () => {
      if (thumbnailPreviewUrl) URL.revokeObjectURL(thumbnailPreviewUrl);
    };
  }, [thumbnailPreviewUrl]);

  const handleSignIn = async () => {
    await saveResumeIntent({ recordingId: recording.id, returnTo: window.location.pathname });
    window.location.href = signInUrl(window.location.pathname);
  };

  const handleSelectThumbnail = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    // Clear the value so re-selecting the same file fires another change event.
    input.value = "";

    if (!file) return;

    if (!/^image\/(png|jpeg|svg\+xml)$/.test(file.type)) {
      setThumbnailError("Choose a PNG, JPG, or SVG image.");
      return;
    }
    if (file.size > MAX_THUMBNAIL_BYTES) {
      setThumbnailError("Image is too large — 5MB max.");
      return;
    }

    setThumbnailError(null);
    setThumbnailFile(file);
    setUseDefaultThumbnail(false);
    setThumbnailPreviewUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });
  };

  const handleUseDefaultThumbnail = () => {
    setThumbnailError(null);
    setThumbnailFile(null);
    setThumbnailPreviewUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    setUseDefaultThumbnail(true);
  };

  const handleRemoveThumbnail = () => {
    setThumbnailFile(null);
    setThumbnailPreviewUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    setUseDefaultThumbnail(false);
    setThumbnailError(null);
  };

  const handleUpload = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setTitleError("Title is required");
      return;
    }
    setTitleError(null);

    try {
      const result = await upload({
        lessonId,
        input: {
          recording,
          title: trimmedTitle,
          description,
          tags: parseTags(tagsInput),
          thumbnail: thumbnailFile ?? undefined,
          useDefaultThumbnail,
        },
      });
      setUploadResult(result);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        // Session expired mid-form — unlike the initial signed-out entry
        // (which never shows a form), typed values must survive this redirect.
        await saveResumeIntent({
          recordingId: recording.id,
          returnTo: window.location.pathname,
          draft: { title: trimmedTitle, description, tags: tagsInput },
        });
        window.location.href = signInUrl(window.location.pathname);
        return;
      }
      // Any other error: `error` from useUploadLesson already reflects it,
      // form values are untouched, retry re-uses the same lessonId.
    }
  };

  const handlePublish = async () => {
    if (!uploadResult) return;
    await publish.mutateAsync(uploadResult.id);
    onClose();
  };

  const handleCopyLink = () => {
    if (!uploadResult) return;
    copyTextToClipboard(`${window.location.origin}/learn/${uploadResult.slug}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Uploading past the halfway point (or once media, not just the tiny .ne,
  // has started) is worth confirming before throwing away; below that
  // threshold just cancel silently — not worth interrupting them to ask.
  const requestClose = () => {
    if (isUploading && progress > 0.5) {
      setCloseConfirmOpen(true);
      return;
    }
    onClose();
  };

  if (authLoading) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-[#0b0d12]/62 px-4 py-8 backdrop-blur-[2px]"
      onClick={requestClose}
    >
      <div
        className="mx-auto flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)]"
        onClick={(event) => event.stopPropagation()}
      >
        {closeConfirmOpen ? (
          <div className="space-y-5 p-5">
            <p className="text-sm font-medium text-slate-100">Cancel upload?</p>
            <p className="text-xs text-slate-400">
              Your recording is already saved — only the upload in progress will stop.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setCloseConfirmOpen(false)}
                className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-400 transition-colors hover:text-white"
              >
                Keep uploading
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded bg-rose-500 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-white transition-colors hover:bg-rose-400"
              >
                Cancel upload
              </button>
            </div>
          </div>
        ) : !isSignedIn ? (
          <div className="space-y-5 p-5">
            <p className="text-sm font-medium text-slate-100">Share this recording?</p>
            <p className="text-xs text-slate-400">
              Sign in to save and share this recording — {formatDuration(recording.duration)} long.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-400 transition-colors hover:text-white"
              >
                Not now
              </button>
              <button
                type="button"
                onClick={() => void handleSignIn()}
                className="rounded-full border border-white/10 bg-white/10 px-4 py-2 text-xs font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
              >
                Sign in with Google
              </button>
            </div>
          </div>
        ) : uploadResult ? (
          <div className="space-y-5 p-5">
            <p className="text-sm font-medium text-slate-100">Saved as a draft</p>
            <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-[#11141c] px-3 py-2">
              <span className="flex-1 truncate font-mono text-xs text-slate-300">
                {window.location.origin}/learn/{uploadResult.slug}
              </span>
              <button
                type="button"
                onClick={handleCopyLink}
                className="shrink-0 text-xs font-semibold text-slate-300 hover:text-white"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-400 transition-colors hover:text-white"
              >
                Keep as draft
              </button>
              <button
                type="button"
                onClick={() => void handlePublish()}
                disabled={publish.isPending}
                className="rounded-full border border-white/10 bg-white/10 px-4 py-2 text-xs font-semibold text-white transition-all hover:bg-white hover:text-slate-950 disabled:cursor-default disabled:opacity-60"
              >
                {publish.isPending ? "Publishing…" : "Publish now"}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-5 overflow-y-auto p-5">
            <p className="text-sm font-medium text-slate-100">Share this recording</p>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-300">Title</span>
              <input
                type="text"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (titleError) setTitleError(null);
                }}
                disabled={isUploading}
                autoFocus={!!titleError}
                className="w-full rounded-lg border border-slate-700 bg-[#11141c] px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-slate-500 disabled:opacity-60"
              />
              {titleError ? <p className="text-xs text-rose-300">{titleError}</p> : null}
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-400">Description (optional)</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={isUploading}
                rows={3}
                className="w-full rounded-lg border border-slate-700 bg-[#11141c] px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-slate-500 disabled:opacity-60"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-400">
                Tags (optional, comma-separated)
              </span>
              <input
                type="text"
                value={tagsInput}
                onChange={(event) => setTagsInput(event.target.value)}
                disabled={isUploading}
                placeholder="intro, basics"
                className="w-full rounded-lg border border-slate-700 bg-[#11141c] px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-slate-500 disabled:opacity-60"
              />
            </label>

            <div className="space-y-1">
              <span className="text-xs font-medium text-slate-400">Thumbnail (optional)</span>
              <div className="flex items-center gap-3">
                {thumbnailPreviewUrl || useDefaultThumbnail ? (
                  <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lg border border-slate-700 bg-[#11141c]">
                    <img
                      src={thumbnailPreviewUrl ?? "/default-thumbnail.webp"}
                      alt="Thumbnail preview"
                      className="size-full object-cover"
                    />
                    {useDefaultThumbnail ? (
                      <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-200">
                        Default
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={handleRemoveThumbnail}
                      disabled={isUploading}
                      aria-label="Remove thumbnail"
                      className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-black/70 text-white transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col items-start gap-1.5">
                    <button
                      type="button"
                      onClick={() => thumbnailInputRef.current?.click()}
                      disabled={isUploading}
                      className="flex aspect-video w-32 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-700 text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <ImagePlus size={18} />
                      <span className="text-[11px] font-medium">Select image</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleUseDefaultThumbnail}
                      disabled={isUploading}
                      className="text-[11px] font-medium text-slate-400 underline-offset-2 transition-colors hover:text-slate-200 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Use default thumbnail
                    </button>
                  </div>
                )}
              </div>
              {thumbnailError ? <p className="text-xs text-rose-300">{thumbnailError}</p> : null}
              <input
                ref={thumbnailInputRef}
                type="file"
                accept={THUMBNAIL_ACCEPT}
                className="hidden"
                onChange={handleSelectThumbnail}
              />
            </div>

            {error ? (
              <p className="text-sm text-rose-300">
                {axios.isAxiosError(error) && error.response?.status === 409
                  ? "That recording was already uploaded — try again."
                  : "Upload failed. Your details are still here — try again."}
              </p>
            ) : null}

            {isUploading ? (
              <div className="space-y-1">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-pinata-purple transition-all"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-slate-400">Uploading… {Math.round(progress * 100)}%</p>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={isUploading}
                className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-400 transition-colors hover:text-white disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  reset();
                  void handleUpload();
                }}
                disabled={isUploading}
                className="rounded bg-emerald-500 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-default disabled:opacity-60"
              >
                {isUploading ? "Uploading…" : error ? "Retry" : "Upload"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
