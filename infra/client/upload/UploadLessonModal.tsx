import { useEffect, useId, useState } from "react";
import axios from "axios";
import type { Recording } from "@app/core/src";
import ModalShell from "@app/components/ModalShell";
import { analytics } from "@app/utils/analytics";
import { copyTextToClipboard } from "@app/utils/clipboard";
import { getRecordingStorage } from "@app/storage/RecordingStorage";
import { useAuth, signInUrl } from "../auth/useAuth";
import { usePublishFromLibrary } from "../library/useMyLessons";
import { useUploadLesson, formatDuration, type UploadLessonInput } from "./useUploadLesson";
import { saveResumeIntent, type ResumeIntent } from "./resumeIntent";
import UploadThumbnailField, { type ThumbnailSelection } from "./UploadThumbnailField";
import UploadCaptionsField, { type SelectedCaption } from "./UploadCaptionsField";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TITLE_CHARS,
  metadataTextError,
} from "../../lessons/metadataLimits";
import GoogleIcon from "@app/components/icon/Google";

export interface UploadLessonModalProps {
  recording: Recording;
  onClose: () => void;
  /** The recording and its media reached the server as a draft lesson. */
  onUploaded?: () => void;
  /** Restored after a "session expired mid-form" round trip (see the UX spec) —
   *  the one case where typed values cross the OAuth redirect. */
  initialTitle?: string;
  initialDescription?: string;
  initialTags?: string;
}

function defaultTitle(createdAt: number): string {
  const date = new Date(createdAt);
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
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
  onUploaded,
  initialTitle,
  initialDescription,
  initialTags,
}: UploadLessonModalProps) {
  const { isSignedIn, isLoading: authLoading } = useAuth();
  // Titles whichever of the modal's views is showing; only one renders at a time.
  const titleId = useId();
  const titleErrorId = useId();
  const [title, setTitle] = useState(initialTitle ?? defaultTitle(recording.createdAt));
  const [description, setDescription] = useState(initialDescription ?? "");
  const [tagsInput, setTagsInput] = useState(initialTags ?? "");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [lessonId] = useState(() => crypto.randomUUID());
  const [uploadResult, setUploadResult] = useState<{
    id: string;
    slug: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [thumbnail, setThumbnail] = useState<ThumbnailSelection>({ kind: "none" });
  const [captionTracks, setCaptionTracks] = useState<SelectedCaption[]>([]);
  const [signInError, setSignInError] = useState<string | null>(null);

  const { upload, cancel, progress, isUploading, error, reset } = useUploadLesson();
  const publish = usePublishFromLibrary();

  // Reset the "Copied" indicator after 2 seconds, with proper cleanup on unmount.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // Signing in is a full-page redirect, which destroys this in-memory take. Store the
  // take on this device first, then the pointer CodeRoute follows back to it. If either
  // cannot be stored, stay here: navigating away would lose the only copy.
  const redirectToSignIn = async (draft?: ResumeIntent["draft"]) => {
    try {
      await getRecordingStorage().save(recording);
      await saveResumeIntent({
        recordingId: recording.id,
        returnTo: window.location.pathname,
        draft,
      });
    } catch (err) {
      console.error("Failed to keep the recording across sign-in", err);
      setSignInError(
        "This recording couldn't be saved on this device, so signing in now would lose it. Export it first, then sign in.",
      );
      return;
    }
    window.location.href = signInUrl(window.location.pathname);
  };

  const handleSignIn = async () => {
    analytics.capture("sign_in_initiated", { trigger: "upload_modal" });
    await redirectToSignIn();
  };

  const handleUpload = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setTitleError("Title is required");
      return;
    }
    setTitleError(null);
    setSignInError(null);

    // maxLength only stops typing: a studio plan title or a draft restored after
    // sign-in can arrive longer. Refuse here rather than upload the whole
    // recording for a POST the Worker would refuse.
    const tags = parseTags(tagsInput);
    const overLimit = metadataTextError({ title: trimmedTitle, description, tags });
    if (overLimit) {
      setLimitError(overLimit);
      return;
    }
    setLimitError(null);

    // Built before the try: the React Compiler can't compile a conditional or
    // optional call inside a try block, and would skip this whole component.
    const input: UploadLessonInput = {
      recording,
      title: trimmedTitle,
      description,
      tags,
      thumbnail: thumbnail.kind === "file" ? thumbnail.file : undefined,
      useDefaultThumbnail: thumbnail.kind === "default",
      captions:
        captionTracks.length > 0
          ? captionTracks.map(({ language, cues }) => ({ language, cues }))
          : undefined,
    };
    try {
      const result = await upload({ lessonId, input });
      setUploadResult(result);
      if (onUploaded) onUploaded();
      analytics.capture("lesson_uploaded", {
        has_thumbnail: thumbnail.kind !== "none",
        has_description: !!description.trim(),
        tag_count: tags.length,
        caption_count: captionTracks.length,
        recording_duration: recording.duration,
      });
    } catch (err) {
      // The user cancelled: the modal is already closing and nothing was
      // created, so this is not a failure to report or a state to reset into.
      if (axios.isCancel(err)) {
        return;
      }
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        // Session expired mid-form — unlike the initial signed-out entry
        // (which never shows a form), typed values must survive this redirect.
        await redirectToSignIn({ title: trimmedTitle, description, tags: tagsInput });
        return;
      }
      // Any other error: `error` from useUploadLesson already reflects it,
      // form values are untouched, retry re-uses the same lessonId.
    }
  };

  const handlePublish = async () => {
    if (!uploadResult) return;
    try {
      await publish.mutateAsync(uploadResult.id);
    } catch {
      // `publish.isError` shows the message; the draft stays, so they can retry.
      return;
    }
    analytics.capture("lesson_published", { lesson_id: uploadResult.id });
    onClose();
  };

  const handleCopyLink = async () => {
    if (!uploadResult) return;
    if (await copyTextToClipboard(`${window.location.origin}/learn/${uploadResult.slug}`)) {
      setCopied(true);
    }
  };

  // Uploading past the halfway point (or once media, not just the tiny .ne,
  // has started) is worth confirming before throwing away; below that
  // threshold just cancel silently — not worth interrupting them to ask.
  // "Silently" still has to mean cancelled: closing without aborting left the
  // upload running and created the lesson anyway.
  const requestClose = () => {
    if (isUploading && progress > 0.5) {
      setCloseConfirmOpen(true);
      return;
    }
    cancel();
    onClose();
  };

  const confirmCancelUpload = () => {
    cancel();
    onClose();
  };

  if (authLoading) {
    return null;
  }

  return (
    <ModalShell maxWidthClassName="max-w-xl" labelledBy={titleId} onDismiss={requestClose}>
      {closeConfirmOpen ? (
        <div className="space-y-5 p-5">
          <h2 id={titleId} className="text-sm font-medium text-slate-100">
            Cancel upload?
          </h2>
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
              onClick={confirmCancelUpload}
              className="rounded bg-rose-500 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-white transition-colors hover:bg-rose-400"
            >
              Cancel upload
            </button>
          </div>
        </div>
      ) : !isSignedIn ? (
        <div className="space-y-5 p-5">
          <h2 id={titleId} className="text-sm font-medium text-slate-100">
            Share this recording?
          </h2>
          <p className="text-xs text-slate-400">
            Sign in to save and share this recording — {formatDuration(recording.duration)} long.
          </p>
          {signInError ? (
            <p role="alert" className="text-xs text-rose-300">
              {signInError}
            </p>
          ) : null}
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
              className="flex gap-3 items-center rounded-full border border-white/10 bg-white/10 px-4 py-2 text-xs font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
            >
              <GoogleIcon /> Sign in with Google
            </button>
          </div>
        </div>
      ) : uploadResult ? (
        <div className="space-y-5 p-5">
          <h2 id={titleId} className="text-sm font-medium text-slate-100">
            Saved as a draft
          </h2>
          <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-[#11141c] px-3 py-2">
            <span className="flex-1 truncate font-mono text-xs text-slate-300">
              {window.location.origin}/learn/{uploadResult.slug}
            </span>
            <button
              type="button"
              onClick={() => void handleCopyLink()}
              className="shrink-0 text-xs font-semibold text-slate-300 hover:text-white"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {publish.isError ? (
            <p role="alert" className="text-xs text-rose-300">
              Couldn't publish — try again.
            </p>
          ) : null}
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
          {/* Mounted with the form so the change to "Uploading…" is announced;
              the visible percentage below would be read out on every tick. */}
          <p role="status" className="sr-only">
            {isUploading ? "Uploading…" : ""}
          </p>
          <h2 id={titleId} className="text-sm font-medium text-slate-100">
            Share this recording
          </h2>

          {/* The error sits outside the label so it describes the field
              instead of becoming part of its name. */}
          <div className="space-y-1">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-300">Title</span>
              <input
                type="text"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (titleError) setTitleError(null);
                  setLimitError(null);
                }}
                maxLength={MAX_TITLE_CHARS}
                disabled={isUploading}
                autoFocus={!!titleError}
                aria-invalid={titleError ? true : undefined}
                aria-describedby={titleError ? titleErrorId : undefined}
                className="w-full rounded-lg border border-slate-700 bg-[#11141c] px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-slate-500 disabled:opacity-60"
              />
            </label>
            {titleError ? (
              <p id={titleErrorId} role="alert" className="text-xs text-rose-300">
                {titleError}
              </p>
            ) : null}
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-slate-400">Description (optional)</span>
            <textarea
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                setLimitError(null);
              }}
              maxLength={MAX_DESCRIPTION_CHARS}
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
              onChange={(event) => {
                setTagsInput(event.target.value);
                setLimitError(null);
              }}
              disabled={isUploading}
              placeholder="intro, basics"
              className="w-full rounded-lg border border-slate-700 bg-[#11141c] px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-slate-500 disabled:opacity-60"
            />
          </label>

          <UploadThumbnailField value={thumbnail} onChange={setThumbnail} disabled={isUploading} />

          <UploadCaptionsField
            value={captionTracks}
            onChange={setCaptionTracks}
            disabled={isUploading}
          />

          {limitError ? (
            <p role="alert" className="text-sm text-rose-300">
              {limitError}
            </p>
          ) : signInError ? (
            <p role="alert" className="text-sm text-rose-300">
              {signInError}
            </p>
          ) : error ? (
            <p role="alert" className="text-sm text-rose-300">
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
    </ModalShell>
  );
}
