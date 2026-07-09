import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, ListMusic, MoreVertical, Trash2, X } from "lucide-react";
import { useDeletePlaylist, useUpdatePlaylist, type OwnedPlaylist } from "@next-editor/infra";

const ghostButton =
  "px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400 transition-colors hover:text-white disabled:cursor-default disabled:opacity-60";

type Confirming = "delete" | null;

// A playlist rendered the same way YouTube renders one: a thumbnail card
// (the first published member's thumbnail, or a placeholder) with a
// lesson-count badge, in the same grid a LessonCard would sit in — not a
// full-width list row. Reorder/add/remove don't fit on a compact card, so
// they live in a separate panel (PlaylistManagePanel) the parent renders
// below the whole grid; this card's menu just requests it via `onManage`.
export default function PlaylistCard({
  playlist,
  isManaging,
  onManage,
  onDeleted,
}: {
  playlist: OwnedPlaylist;
  isManaging: boolean;
  onManage: () => void;
  onDeleted: () => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleValue, setTitleValue] = useState(playlist.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const update = useUpdatePlaylist();
  const del = useDeletePlaylist();

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  const href = `/learn/playlist/${playlist.slug}`;

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

  return (
    <div className="group">
      <div
        className={`relative aspect-video rounded-xl bg-slate-900 ${
          isManaging ? "ring-2 ring-pinata-purple" : ""
        }`}
      >
        <div className="absolute inset-0 overflow-hidden rounded-xl">
          {thumbFailed || !playlist.thumbnail ? (
            <div className="flex size-full items-center justify-center bg-slate-800 text-slate-600">
              <ListMusic className="size-8" />
            </div>
          ) : (
            <img
              src={`/${playlist.thumbnail}`}
              alt=""
              loading="lazy"
              onError={() => setThumbFailed(true)}
              className="size-full object-cover"
            />
          )}
        </div>

        <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white">
          <ListMusic className="size-3" />
          {playlist.lessonCount}
        </span>

        <div className="absolute right-2 top-2">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Playlist options"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="flex size-7 items-center justify-center rounded-full bg-black/70 text-white transition-colors hover:bg-black"
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
                    onManage();
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white transition-colors hover:bg-white/10"
                >
                  <ListMusic className="size-4 text-slate-400" />
                  Manage lessons
                </button>
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
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug">
            <Link
              to={href}
              className="rounded text-white outline-none focus-visible:ring-2 focus-visible:ring-pinata-purple hover:underline"
            >
              {playlist.title}
            </Link>
          </h3>
        )}

        {titleError && <p className="text-xs text-rose-300">{titleError}</p>}
        {deleteError && <p className="text-xs text-rose-300">{deleteError}</p>}

        {confirming === "delete" && (
          <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5">
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
                  setDeleteError(null);
                  del.mutate(playlist.id, {
                    onSuccess: onDeleted,
                    onError: () => setDeleteError("Couldn't delete the playlist — try again."),
                  });
                }}
                className="rounded bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-400"
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
