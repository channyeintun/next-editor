import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import {
  useRemoveLessonFromPlaylist,
  useReorderPlaylistLessons,
  type OwnedLesson,
  type OwnedPlaylist,
} from "@next-editor/infra";
import { usePlaylist } from "../hooks/usePlaylists";

// Reorder/remove for exactly one playlist at a time, opened via a card's
// "Manage lessons" menu item. A real modal (matching
// infra/client/upload/UploadLessonModal's backdrop/card shell), not an
// inline panel — a compact thumbnail card has no room for this, and
// anchoring it under the grid instead of centering it read as an odd
// half-inline, half-popover hybrid.
//
// Deliberately does NOT include a "browse and add" list here — adding has
// one canonical place now (AddToPlaylistPopover, from each lesson's own
// menu), rather than duplicating a second unfiltered "pick from everything"
// surface here that only gets more unwieldy as a library grows.
export default function PlaylistManagePanel({
  playlist,
  publishedLessons,
  onClose,
}: {
  playlist: OwnedPlaylist;
  publishedLessons: OwnedLesson[];
  onClose: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  // Scopes the remove-busy state to the one lesson actually being removed —
  // the mutation hook below is shared across every row in this panel, so its
  // own isPending would otherwise disable every row's button while any one
  // of them is in flight.
  const [removingLessonId, setRemovingLessonId] = useState<string | null>(null);

  const removeLesson = useRemoveLessonFromPlaylist();
  const reorder = useReorderPlaylistLessons();

  const { data: detail, isPending: detailPending } = usePlaylist(playlist.slug);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // The public Lesson shape has no `id` (only owner-facing OwnedLesson does),
  // so membership is reconciled by slug: a member's slug matched against the
  // owner's own published lessons gives back the id the mutation APIs need.
  const orderedMembers = (detail?.lessons ?? [])
    .map((member) => publishedLessons.find((l) => l.slug === member.slug))
    .filter((l): l is OwnedLesson => !!l);
  const orderedMemberIds = orderedMembers.map((l) => l.id);

  const moveMember = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= orderedMemberIds.length) return;
    const next = [...orderedMemberIds];
    [next[index], next[target]] = [next[target], next[index]];
    setActionError(null);
    reorder.mutate(
      { playlistId: playlist.id, lessonIds: next },
      { onError: () => setActionError("Couldn't reorder — try again.") },
    );
  };

  const removeMember = (lessonId: string) => {
    setActionError(null);
    setRemovingLessonId(lessonId);
    removeLesson.mutate(
      { playlistId: playlist.id, lessonId },
      {
        onSettled: () => setRemovingLessonId(null),
        onError: () => setActionError("Couldn't remove that lesson — try again."),
      },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[#0b0d12]/62 px-4 py-16 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
          <h3 className="min-w-0 truncate text-sm font-semibold text-white">
            Manage &ldquo;{playlist.title}&rdquo;
          </h3>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-5">
          {actionError && <p className="mb-2 text-xs text-rose-300">{actionError}</p>}

          {detailPending ? (
            <p className="text-xs text-slate-500">Loading…</p>
          ) : orderedMembers.length === 0 ? (
            <p className="text-xs text-slate-500">No lessons yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {orderedMembers.map((lesson, index) => (
                <li key={lesson.id} className="flex items-center gap-2 text-sm">
                  <span className="flex shrink-0 gap-0.5">
                    <button
                      type="button"
                      aria-label="Move up"
                      disabled={index <= 0 || reorder.isPending}
                      onClick={() => moveMember(index, -1)}
                      className="rounded p-1 text-slate-500 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      disabled={index >= orderedMembers.length - 1 || reorder.isPending}
                      onClick={() => moveMember(index, 1)}
                      className="rounded p-1 text-slate-500 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-300">{lesson.title}</span>
                  <button
                    type="button"
                    disabled={removingLessonId === lesson.id}
                    onClick={() => removeMember(lesson.id)}
                    className="shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-60"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="border-t border-white/10 px-5 py-3 text-xs text-slate-500">
          Add more from a lesson's own menu — &ldquo;Add to playlist&rdquo;.
        </p>
      </div>
    </div>
  );
}
