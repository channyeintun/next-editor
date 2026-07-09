import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  ListMusic,
  MoreVertical,
  Trash2,
  X,
} from "lucide-react";
import {
  useAddLessonToPlaylist,
  useCreatePlaylist,
  useDeletePlaylist,
  useRemoveLessonFromPlaylist,
  useReorderPlaylistLessons,
  useUpdatePlaylist,
  type OwnedLesson,
  type OwnedPlaylist,
} from "@next-editor/infra";
import { usePlaylist } from "../hooks/usePlaylists";

const ghostButton =
  "px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400 transition-colors hover:text-white disabled:cursor-default disabled:opacity-60";
const confirmButton =
  "rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-white hover:text-slate-950";

// A lightweight management surface for the owner's playlists, mounted inside
// MyLibraryGrid above the lessons grid. Only the owner's own PUBLISHED
// lessons are ever addable — playlists are always public (no draft state),
// so a draft lesson must never become reachable through one.
export default function PlaylistsSection({
  playlists,
  lessons,
}: {
  playlists: OwnedPlaylist[];
  lessons: OwnedLesson[];
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const createPlaylist = useCreatePlaylist();

  const publishedLessons = lessons.filter((l) => l.status === "published");

  const submitCreate = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError("Playlist name can't be empty.");
      return;
    }
    setTitleError(null);
    createPlaylist.mutate(
      { title: trimmed, description: description.trim() || undefined },
      {
        onSuccess: () => {
          setTitle("");
          setDescription("");
          setCreating(false);
        },
        onError: () => setTitleError("Couldn't create the playlist — try again."),
      },
    );
  };

  return (
    <div className="mb-8 space-y-3 border-b border-white/10 pb-8">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.06em] text-slate-300">
          <ListMusic className="size-4" />
          Playlists
        </h2>
        {!creating && (
          <button type="button" onClick={() => setCreating(true)} className={ghostButton}>
            New playlist
          </button>
        )}
      </div>

      {creating && (
        <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 p-3">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Playlist name"
            disabled={createPlaylist.isPending}
            className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white outline-none focus:border-pinata-purple/60 disabled:opacity-60"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            disabled={createPlaylist.isPending}
            className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white outline-none focus:border-pinata-purple/60 disabled:opacity-60"
          />
          {titleError && <p className="text-xs text-rose-300">{titleError}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setTitle("");
                setDescription("");
                setTitleError(null);
              }}
              disabled={createPlaylist.isPending}
              className={ghostButton}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitCreate}
              disabled={createPlaylist.isPending}
              className={confirmButton}
            >
              Create
            </button>
          </div>
        </div>
      )}

      {playlists.length === 0 && !creating ? (
        <p className="text-sm text-slate-500">
          Group related lessons into a playlist so viewers can watch them in order.
        </p>
      ) : (
        <div className="space-y-2">
          {playlists.map((playlist) => (
            <PlaylistManageRow
              key={playlist.id}
              playlist={playlist}
              publishedLessons={publishedLessons}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type Confirming = "delete" | null;

function PlaylistManageRow({
  playlist,
  publishedLessons,
}: {
  playlist: OwnedPlaylist;
  publishedLessons: OwnedLesson[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleValue, setTitleValue] = useState(playlist.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Scopes the add/remove busy state to the one lesson actually being
  // toggled — the mutation hooks below are shared across every lesson row in
  // this panel, so their own isPending would otherwise disable every row's
  // button while any one of them is in flight.
  const [togglingLessonId, setTogglingLessonId] = useState<string | null>(null);

  const update = useUpdatePlaylist();
  const del = useDeletePlaylist();
  const addLesson = useAddLessonToPlaylist();
  const removeLesson = useRemoveLessonFromPlaylist();
  const reorder = useReorderPlaylistLessons();

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  // Only fetched once expanded — avoids firing one detail request per
  // playlist row on every My Library load.
  const { data: detail, isPending: detailPending } = usePlaylist(
    expanded ? playlist.slug : undefined,
  );

  const submitRename = () => {
    const trimmed = titleValue.trim();
    if (!trimmed) {
      setTitleError("Playlist name can't be empty.");
      return;
    }
    if (trimmed === playlist.title) {
      setRenaming(false);
      return;
    }
    setTitleError(null);
    update.mutate(
      { playlistId: playlist.id, title: trimmed },
      {
        onSuccess: () => setRenaming(false),
        onError: () => setTitleError("Couldn't rename the playlist — try again."),
      },
    );
  };

  // The public Lesson shape has no `id` (only owner-facing OwnedLesson does),
  // so membership is reconciled by slug: a member's slug matched against the
  // owner's own published lessons gives back the id the mutation APIs need.
  const memberSlugs = new Set(detail?.lessons.map((l) => l.slug) ?? []);
  const orderedMemberIds = (detail?.lessons ?? [])
    .map((member) => publishedLessons.find((l) => l.slug === member.slug)?.id)
    .filter((id): id is string => !!id);

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
    <div className="rounded-lg border border-white/10 bg-white/5">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse" : "Expand"}
          className="shrink-0 text-slate-400 transition-colors hover:text-white"
        >
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>

        <div className="min-w-0 flex-1">
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
                disabled={update.isPending}
                className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm text-white outline-none focus:border-pinata-purple/60 disabled:opacity-60"
              />
              <button
                type="button"
                aria-label="Save playlist name"
                onClick={submitRename}
                disabled={update.isPending}
                className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
              >
                <Check className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Cancel rename"
                onClick={() => setRenaming(false)}
                disabled={update.isPending}
                className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <Link
              to={`/learn/playlist/${playlist.slug}`}
              className="truncate text-sm font-semibold text-white hover:underline"
            >
              {playlist.title}
            </Link>
          )}
          {!renaming && (
            <p className="text-xs text-slate-500">
              {playlist.lessonCount} {playlist.lessonCount === 1 ? "lesson" : "lessons"}
            </p>
          )}
          {titleError && <p className="text-xs text-rose-300">{titleError}</p>}
        </div>

        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Playlist options"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="flex size-7 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
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
                className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-xl border border-white/10 bg-[#11141c] text-left shadow-xl"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setTitleValue(playlist.title);
                    setTitleError(null);
                    setRenaming(true);
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white transition-colors hover:bg-white/10"
                >
                  Rename
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
      </div>

      {actionError && <p className="px-3 pb-2 text-xs text-rose-300">{actionError}</p>}

      {confirming === "delete" && (
        <div className="mx-3 mb-3 space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5">
          <p className="text-xs text-slate-300">
            Delete this playlist permanently? This can't be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirming(null)} className={ghostButton}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(null);
                setActionError(null);
                del.mutate(playlist.id, {
                  onError: () => setActionError("Couldn't delete the playlist — try again."),
                });
              }}
              className="rounded bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-400"
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="border-t border-white/10 p-3">
          {detailPending ? (
            <p className="text-xs text-slate-500">Loading…</p>
          ) : publishedLessons.length === 0 ? (
            <p className="text-xs text-slate-500">Publish a lesson to add it to this playlist.</p>
          ) : (
            <ul className="space-y-1.5">
              {publishedLessons.map((lesson) => {
                const isMember = memberSlugs.has(lesson.slug);
                const memberIndex = orderedMemberIds.indexOf(lesson.id);
                return (
                  <li key={lesson.id} className="flex items-center gap-2 text-sm">
                    {isMember && (
                      <span className="flex shrink-0 gap-0.5">
                        <button
                          type="button"
                          aria-label="Move up"
                          disabled={memberIndex <= 0 || reorder.isPending}
                          onClick={() => moveMember(memberIndex, -1)}
                          className="rounded p-1 text-slate-500 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
                        >
                          <ArrowUp className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="Move down"
                          disabled={memberIndex >= orderedMemberIds.length - 1 || reorder.isPending}
                          onClick={() => moveMember(memberIndex, 1)}
                          className="rounded p-1 text-slate-500 transition-colors hover:text-white disabled:cursor-default disabled:opacity-30"
                        >
                          <ArrowDown className="size-3.5" />
                        </button>
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-slate-300">{lesson.title}</span>
                    <button
                      type="button"
                      disabled={togglingLessonId === lesson.id}
                      onClick={() => toggleMember(lesson.id, isMember)}
                      className={
                        isMember
                          ? "shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60"
                          : "shrink-0 rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-white hover:text-slate-950 disabled:opacity-60"
                      }
                    >
                      {isMember ? "Remove" : "Add"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
