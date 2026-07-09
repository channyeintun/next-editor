import { useEffect, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import {
  useAddLessonToPlaylist,
  useCreatePlaylist,
  usePlaylistsForLesson,
  useRemoveLessonFromPlaylist,
  type OwnedLesson,
  type OwnedPlaylistWithMembership,
} from "@next-editor/infra";

// Below this count, a filter box is just clutter — scanning 2-6 playlists by
// eye is faster than typing. Above it, a flat scroll with no way to jump to
// one by name stops working, so the filter earns its place in the popover.
const FILTER_THRESHOLD = 6;

// Lesson-first "Save to playlist" flow (the YouTube pattern): opened from a
// lesson card's own menu, lists every one of the owner's playlists as a
// toggle pre-checked by current membership, plus an inline quick-create.
// Complements (doesn't replace) PlaylistsSection's playlist-first manage
// panel in My Library, which is still where reordering/rename/delete live.
export default function AddToPlaylistPopover({
  lesson,
  onClose,
}: {
  lesson: OwnedLesson;
  onClose: () => void;
}) {
  const [creatingNew, setCreatingNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const { data: playlists, isPending, isError } = usePlaylistsForLesson(lesson.id);
  const createPlaylist = useCreatePlaylist();
  const addLesson = useAddLessonToPlaylist();
  const removeLesson = useRemoveLessonFromPlaylist();

  const showFilter = (playlists?.length ?? 0) > FILTER_THRESHOLD;
  const trimmedFilter = filter.trim().toLowerCase();
  const visiblePlaylists =
    showFilter && trimmedFilter
      ? playlists?.filter((p) => p.title.toLowerCase().includes(trimmedFilter))
      : playlists;

  // Escape backs out one layer at a time: cancel the quick-create sub-form
  // first, then clear an active filter, and only then close the whole
  // popover — mirrors how a nested form/dialog pair should unwind.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (creatingNew) {
        setCreatingNew(false);
      } else if (filter) {
        setFilter("");
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [creatingNew, filter, onClose]);

  const toggle = (playlist: OwnedPlaylistWithMembership) => {
    setToggleError(null);
    setTogglingId(playlist.id);
    const mutation = playlist.containsLesson ? removeLesson : addLesson;
    mutation.mutate(
      { playlistId: playlist.id, lessonId: lesson.id },
      {
        onSettled: () => setTogglingId(null),
        onError: () => setToggleError("Couldn't update that playlist — try again."),
      },
    );
  };

  const submitCreate = () => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setCreateError(null);
    createPlaylist.mutate(
      { title: trimmed },
      {
        onSuccess: (created) => {
          setNewTitle("");
          setCreatingNew(false);
          setTogglingId(created.id);
          addLesson.mutate(
            { playlistId: created.id, lessonId: lesson.id },
            { onSettled: () => setTogglingId(null) },
          );
        },
        onError: () => setCreateError("Couldn't create the playlist — try again."),
      },
    );
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Add to playlist"
        className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-white/10 bg-[#11141c] text-left shadow-xl"
      >
        <div className="border-b border-white/10 px-4 py-2.5">
          <p className="text-sm font-semibold text-white">Add to playlist</p>
        </div>

        {showFilter && (
          <div className="border-b border-white/10 p-1.5">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a playlist"
              className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm text-white outline-none focus:border-pinata-purple/60"
            />
          </div>
        )}

        <div
          className={
            isPending || isError || playlists?.length ? "max-h-60 overflow-y-auto p-1.5" : ""
          }
        >
          {isPending ? (
            <p className="px-2.5 py-2 text-xs text-slate-500">Loading…</p>
          ) : isError ? (
            <p className="px-2.5 py-2 text-xs text-rose-300">Couldn't load your playlists.</p>
          ) : trimmedFilter && visiblePlaylists?.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-slate-500">
              No playlists match "{filter.trim()}".
            </p>
          ) : (
            visiblePlaylists?.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                disabled={togglingId === playlist.id}
                onClick={() => toggle(playlist)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-white transition-colors hover:bg-white/10 disabled:cursor-default disabled:opacity-60"
              >
                <span
                  className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                    playlist.containsLesson
                      ? "border-pinata-purple bg-pinata-purple"
                      : "border-white/20"
                  }`}
                >
                  {playlist.containsLesson && <Check className="size-3 text-white" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{playlist.title}</span>
              </button>
            ))
          )}
        </div>

        {toggleError && <p className="px-4 pb-2 text-xs text-rose-300">{toggleError}</p>}

        <div className="border-t border-white/10 p-1.5">
          {creatingNew ? (
            <div className="flex items-center gap-1.5 px-1 py-0.5">
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCreate();
                }}
                placeholder="Playlist name"
                disabled={createPlaylist.isPending}
                className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm text-white outline-none focus:border-pinata-purple/60 disabled:opacity-60"
              />
              <button
                type="button"
                aria-label="Create playlist"
                onClick={submitCreate}
                disabled={createPlaylist.isPending}
                className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
              >
                <Check className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Cancel"
                onClick={() => setCreatingNew(false)}
                disabled={createPlaylist.isPending}
                className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreatingNew(true)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Plus className="size-4" />
              New playlist
            </button>
          )}
          {createError && <p className="px-2.5 pt-1 text-xs text-rose-300">{createError}</p>}
        </div>
      </div>
    </>
  );
}
