import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Check,
  Eye,
  EyeOff,
  ImagePlus,
  ListMusic,
  MoreVertical,
  Pencil,
  Play,
  Trash2,
  X,
} from "lucide-react";
import {
  MAX_THUMBNAIL_BYTES,
  resizeThumbnail,
  THUMBNAIL_ACCEPT,
  useDeleteLesson,
  usePublishFromLibrary,
  useUnpublishLesson,
  useUpdateLessonName,
  useUpdateThumbnail,
  type OwnedLesson,
} from "@next-editor/infra";
import AddToPlaylistPopover from "./AddToPlaylistPopover";

type Confirming = "unpublish" | "delete" | null;

const ghostButton =
  "px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400 transition-colors hover:text-white disabled:cursor-default disabled:opacity-60";
const confirmButton =
  "rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-white hover:text-slate-950";

export default function MyLessonCard({ lesson }: { lesson: OwnedLesson }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addingToPlaylist, setAddingToPlaylist] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleValue, setTitleValue] = useState(lesson.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const thumbnailInputRef = useRef<HTMLInputElement | null>(null);

  const publish = usePublishFromLibrary();
  const unpublish = useUnpublishLesson();
  const del = useDeleteLesson();
  const updateThumbnail = useUpdateThumbnail();
  const updateName = useUpdateLessonName();

  const isPublished = lesson.status === "published";
  const isBusy =
    publish.isPending ||
    unpublish.isPending ||
    del.isPending ||
    updateThumbnail.isPending ||
    updateName.isPending;
  const hasMutationError =
    publish.isError || unpublish.isError || del.isError || updateThumbnail.isError;

  const handleSelectThumbnail = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    // Clear the value so re-selecting the same file fires another change event.
    input.value = "";
    if (!file) return;

    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      setThumbnailError("Choose a PNG or JPG image.");
      return;
    }
    if (file.size > MAX_THUMBNAIL_BYTES) {
      setThumbnailError("Image is too large — 5MB max.");
      return;
    }

    setThumbnailError(null);
    const optimized = await resizeThumbnail(file);
    updateThumbnail.mutate({ lessonId: lesson.id, thumbnail: optimized });
  };

  const submitRename = () => {
    const trimmed = titleValue.trim();
    if (!trimmed) {
      setTitleError("Lesson name can't be empty.");
      return;
    }
    if (trimmed === lesson.title) {
      setRenaming(false);
      return;
    }
    setTitleError(null);
    updateName.mutate(
      { lessonId: lesson.id, title: trimmed },
      {
        onSuccess: () => setRenaming(false),
        onError: () => setTitleError("Couldn't update the lesson name — try again."),
      },
    );
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <div className="group">
      <div className="relative aspect-video rounded-xl bg-slate-900">
        <div className="absolute inset-0 overflow-hidden rounded-xl">
          {thumbFailed ? (
            <div className="flex size-full items-center justify-center bg-slate-800 text-slate-600">
              <Play className="size-8" />
            </div>
          ) : (
            <img
              src={`/${lesson.thumbnail}`}
              alt={lesson.title}
              loading="lazy"
              onError={() => setThumbFailed(true)}
              className="size-full object-cover"
            />
          )}
        </div>
        <span
          className={`absolute left-2 top-2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            isPublished ? "bg-emerald-500/90 text-slate-950" : "bg-black/80 text-slate-300"
          }`}
        >
          {isPublished ? "Published" : "Draft"}
        </span>
        {lesson.duration && (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white">
            {lesson.duration}
          </span>
        )}

        <div className="absolute right-2 top-2">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            disabled={isBusy}
            aria-label="Lesson options"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="flex size-7 items-center justify-center rounded-full bg-black/70 text-white transition-colors hover:bg-black disabled:cursor-default disabled:opacity-60"
          >
            <MoreVertical className="size-4" />
          </button>

          {menuOpen && (
            <>
              <button
                type="button"
                aria-label="Close menu"
                className="fixed inset-0 z-40 cursor-default"
                onClick={() => setMenuOpen(false)}
              />
              <div
                role="menu"
                className="absolute right-0 z-50 mt-2 w-48 overflow-hidden rounded-xl border border-white/10 bg-[#11141c] text-left shadow-xl"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    if (isPublished) {
                      setConfirming("unpublish");
                    } else {
                      publish.mutate(lesson.id);
                    }
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white transition-colors hover:bg-white/10"
                >
                  {isPublished ? (
                    <EyeOff className="size-4 text-slate-400" />
                  ) : (
                    <Eye className="size-4 text-slate-400" />
                  )}
                  {isPublished ? "Unpublish" : "Publish"}
                </button>
                {isPublished && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setAddingToPlaylist(true);
                    }}
                    className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white transition-colors hover:bg-white/10"
                  >
                    <ListMusic className="size-4 text-slate-400" />
                    Add to playlist
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    thumbnailInputRef.current?.click();
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white transition-colors hover:bg-white/10"
                >
                  <ImagePlus className="size-4 text-slate-400" />
                  Update thumbnail
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setTitleValue(lesson.title);
                    setTitleError(null);
                    setRenaming(true);
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white transition-colors hover:bg-white/10"
                >
                  <Pencil className="size-4 text-slate-400" />
                  Update lesson name
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setConfirming("delete");
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-rose-300 transition-colors hover:bg-white/10"
                >
                  <Trash2 className="size-4" />
                  Delete
                </button>
              </div>
            </>
          )}

          {addingToPlaylist && (
            <AddToPlaylistPopover lesson={lesson} onClose={() => setAddingToPlaylist(false)} />
          )}
        </div>

        <input
          ref={thumbnailInputRef}
          type="file"
          accept={THUMBNAIL_ACCEPT}
          className="hidden"
          onChange={handleSelectThumbnail}
        />
      </div>

      <div className="mt-3 space-y-2">
        {renaming ? (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              disabled={updateName.isPending}
              className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm text-white outline-none focus:border-pinata-purple/60 disabled:opacity-60"
            />
            <button
              type="button"
              aria-label="Save lesson name"
              onClick={submitRename}
              disabled={updateName.isPending}
              className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
            >
              <Check className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Cancel rename"
              onClick={() => setRenaming(false)}
              disabled={updateName.isPending}
              className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : (
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-white">
            {isPublished ? (
              <Link
                to={`/learn/${lesson.slug}`}
                className="rounded outline-none focus-visible:ring-2 focus-visible:ring-pinata-purple hover:underline"
              >
                {lesson.title}
              </Link>
            ) : (
              lesson.title
            )}
          </h3>
        )}

        {thumbnailError ? <p className="text-xs text-rose-300">{thumbnailError}</p> : null}
        {titleError ? <p className="text-xs text-rose-300">{titleError}</p> : null}
        {!thumbnailError && !titleError && hasMutationError && confirming === null ? (
          <p className="text-xs text-rose-300">Something went wrong — try again.</p>
        ) : null}
        {updateThumbnail.isPending ? (
          <p className="text-xs text-slate-400">Updating thumbnail…</p>
        ) : null}
        {updateName.isPending ? (
          <p className="text-xs text-slate-400">Updating lesson name…</p>
        ) : null}

        {confirming === "unpublish" ? (
          <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 p-2.5">
            <p className="text-xs text-slate-300">
              Unpublish this lesson? It’ll disappear from the public gallery and any shared link
              will stop working. You can publish it again anytime.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirming(null)} className={ghostButton}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(null);
                  unpublish.mutate(lesson.id);
                }}
                className={confirmButton}
              >
                Confirm
              </button>
            </div>
          </div>
        ) : confirming === "delete" ? (
          <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5">
            <p className="text-xs text-slate-300">
              Delete this lesson permanently? This can’t be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirming(null)} className={ghostButton}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(null);
                  del.mutate(lesson.id);
                }}
                className="rounded bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-400"
              >
                Delete
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
