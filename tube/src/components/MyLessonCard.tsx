import { useState } from "react";
import { Link } from "react-router";
import { Play } from "lucide-react";
import {
  useDeleteLesson,
  usePublishFromLibrary,
  useUnpublishLesson,
  type OwnedLesson,
} from "@next-editor/infra";

type Confirming = "unpublish" | "delete" | null;

const pillButton =
  "rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-white hover:text-slate-950 disabled:cursor-default disabled:opacity-60";
const ghostButton =
  "px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400 transition-colors hover:text-white disabled:cursor-default disabled:opacity-60";

export default function MyLessonCard({ lesson }: { lesson: OwnedLesson }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const publish = usePublishFromLibrary();
  const unpublish = useUnpublishLesson();
  const del = useDeleteLesson();

  const isPublished = lesson.status === "published";
  const isBusy = publish.isPending || unpublish.isPending || del.isPending;
  const hasError = publish.isError || unpublish.isError || del.isError;

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

        {hasError && confirming === null ? (
          <p className="text-xs text-rose-300">Something went wrong — try again.</p>
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
                className={pillButton}
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
        ) : (
          <div className="flex items-center gap-2">
            {isPublished ? (
              <button
                type="button"
                onClick={() => setConfirming("unpublish")}
                disabled={isBusy}
                className={pillButton}
              >
                {unpublish.isPending ? "Unpublishing…" : "Unpublish"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => publish.mutate(lesson.id)}
                disabled={isBusy}
                className={pillButton}
              >
                {publish.isPending ? "Publishing…" : "Publish"}
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirming("delete")}
              disabled={isBusy}
              className={ghostButton}
            >
              {del.isPending ? "Deleting…" : "Delete"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
