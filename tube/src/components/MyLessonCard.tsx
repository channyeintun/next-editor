import { useRef, useState } from "react";
import { Link } from "react-router";
import { Eye, EyeOff, ImagePlus, MoreVertical, Play, Trash2 } from "lucide-react";
import {
  MAX_THUMBNAIL_BYTES,
  resizeThumbnail,
  THUMBNAIL_ACCEPT,
  useDeleteLesson,
  usePublishFromLibrary,
  useUnpublishLesson,
  useUpdateThumbnail,
  type OwnedLesson,
} from "@next-editor/infra";

type Confirming = "unpublish" | "delete" | null;

const ghostButton =
  "px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400 transition-colors hover:text-white disabled:cursor-default disabled:opacity-60";
const confirmButton =
  "rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-white hover:text-slate-950";

export default function MyLessonCard({ lesson }: { lesson: OwnedLesson }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const thumbnailInputRef = useRef<HTMLInputElement | null>(null);

  const publish = usePublishFromLibrary();
  const unpublish = useUnpublishLesson();
  const del = useDeleteLesson();
  const updateThumbnail = useUpdateThumbnail();

  const isPublished = lesson.status === "published";
  const isBusy =
    publish.isPending || unpublish.isPending || del.isPending || updateThumbnail.isPending;
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

  return (
    <div className="group">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-900">
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

        {thumbnailError ? <p className="text-xs text-rose-300">{thumbnailError}</p> : null}
        {!thumbnailError && hasMutationError && confirming === null ? (
          <p className="text-xs text-rose-300">Something went wrong — try again.</p>
        ) : null}
        {updateThumbnail.isPending ? (
          <p className="text-xs text-slate-400">Updating thumbnail…</p>
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
