import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import {
  useAddLessonToPlaylist,
  useRemoveLessonFromPlaylist,
  useReorderPlaylistLessons,
  type OwnedLesson,
  type OwnedPlaylist,
} from "@next-editor/infra";
import { usePlaylist } from "../hooks/usePlaylists";

// Below this count, a filter box on the "add lessons" list is just clutter.
// Above it, scrolling a flat unfiltered list stops working — same reasoning
// as AddToPlaylistPopover's threshold.
const ADD_FILTER_THRESHOLD = 6;

// Reorder/add/remove for exactly one playlist at a time, rendered below the
// whole PlaylistsSection grid (not inline in a card — a compact thumbnail
// card has no room for this). Opened via a card's "Manage lessons" menu item.
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
  // Scopes the add/remove busy state to the one lesson actually being
  // toggled — the mutation hooks below are shared across every lesson row in
  // this panel, so their own isPending would otherwise disable every row's
  // button while any one of them is in flight.
  const [togglingLessonId, setTogglingLessonId] = useState<string | null>(null);
  // "Add lessons" is a secondary, collapsed-by-default action — adding now
  // primarily happens lesson-first, from each lesson card's own "Add to
  // playlist" menu (AddToPlaylistPopover); this stays available for
  // bulk-adding several lessons to a playlist at once.
  const [addingLessons, setAddingLessons] = useState(false);
  const [addFilter, setAddFilter] = useState("");

  const addLesson = useAddLessonToPlaylist();
  const removeLesson = useRemoveLessonFromPlaylist();
  const reorder = useReorderPlaylistLessons();

  const { data: detail, isPending: detailPending } = usePlaylist(playlist.slug);

  // Escape backs out one layer at a time: close the "add lessons" sub-form
  // first, then the whole panel.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (addingLessons) {
        setAddingLessons(false);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [addingLessons, onClose]);

  // The public Lesson shape has no `id` (only owner-facing OwnedLesson does),
  // so membership is reconciled by slug: a member's slug matched against the
  // owner's own published lessons gives back the id the mutation APIs need.
  const memberSlugs = new Set(detail?.lessons.map((l) => l.slug) ?? []);
  const orderedMembers = (detail?.lessons ?? [])
    .map((member) => publishedLessons.find((l) => l.slug === member.slug))
    .filter((l): l is OwnedLesson => !!l);
  const orderedMemberIds = orderedMembers.map((l) => l.id);
  const nonMembers = publishedLessons.filter((l) => !memberSlugs.has(l.slug));
  const addFilterActive = nonMembers.length > ADD_FILTER_THRESHOLD;
  const trimmedAddFilter = addFilter.trim().toLowerCase();
  const visibleNonMembers =
    addFilterActive && trimmedAddFilter
      ? nonMembers.filter((l) => l.title.toLowerCase().includes(trimmedAddFilter))
      : nonMembers;

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

  const toggleMember = (lessonId: string, isMember: boolean) => {
    setActionError(null);
    setTogglingLessonId(lessonId);
    const mutation = isMember ? removeLesson : addLesson;
    mutation.mutate(
      { playlistId: playlist.id, lessonId },
      {
        onSettled: () => setTogglingLessonId(null),
        onError: () => setActionError("Couldn't update the playlist — try again."),
      },
    );
  };

  return (
    <div className="mt-2 rounded-lg border border-white/10 bg-white/5 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate text-sm font-semibold text-white">
          Manage &ldquo;{playlist.title}&rdquo;
        </h3>
        <button
          type="button"
          aria-label="Done managing playlist"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white"
        >
          <X className="size-4" />
        </button>
      </div>

      {actionError && <p className="mb-2 text-xs text-rose-300">{actionError}</p>}

      {detailPending ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <>
          {orderedMembers.length === 0 ? (
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
                    disabled={togglingLessonId === lesson.id}
                    onClick={() => toggleMember(lesson.id, true)}
                    className="shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-60"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          {publishedLessons.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">
              Publish a lesson to add it to this playlist.
            </p>
          ) : (
            <div className="mt-2">
              {addingLessons ? (
                <div className="space-y-1.5 rounded-lg border border-white/10 bg-black/20 p-2">
                  {addFilterActive && (
                    <input
                      autoFocus
                      value={addFilter}
                      onChange={(e) => setAddFilter(e.target.value)}
                      placeholder="Find a lesson"
                      className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm text-white outline-none focus:border-pinata-purple/60"
                    />
                  )}
                  {nonMembers.length === 0 ? (
                    <p className="p-1 text-xs text-slate-500">
                      All your published lessons are already in this playlist.
                    </p>
                  ) : trimmedAddFilter && visibleNonMembers.length === 0 ? (
                    <p className="p-1 text-xs text-slate-500">
                      No lessons match "{addFilter.trim()}".
                    </p>
                  ) : (
                    <ul className="max-h-48 space-y-1 overflow-y-auto">
                      {visibleNonMembers.map((lesson) => (
                        <li key={lesson.id} className="flex items-center gap-2 text-sm">
                          <span className="min-w-0 flex-1 truncate text-slate-300">
                            {lesson.title}
                          </span>
                          <button
                            type="button"
                            disabled={togglingLessonId === lesson.id}
                            onClick={() => toggleMember(lesson.id, false)}
                            className="shrink-0 rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-white hover:text-slate-950 disabled:cursor-default disabled:opacity-60"
                          >
                            Add
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setAddingLessons(false);
                      setAddFilter("");
                    }}
                    className="text-xs font-semibold text-slate-400 transition-colors hover:text-white"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingLessons(true)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 transition-colors hover:text-white"
                >
                  <Plus className="size-3.5" />
                  Add lessons
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
