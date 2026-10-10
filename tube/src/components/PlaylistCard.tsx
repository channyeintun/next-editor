import { useId, useRef, useState } from "react";
import { Link } from "react-router";
import { Check, ListMusic, MoreVertical, Trash2, X } from "lucide-react";
import {
  MAX_TITLE_CHARS,
  useDeletePlaylist,
  useUpdatePlaylist,
  type OwnedPlaylist,
} from "@next-editor/infra";
import LangText from "@app/components/LangText";
import PopoverMenu from "@app/components/PopoverMenu";
import { resolveThumb } from "../lib/links";
import ThumbnailTile from "./ThumbnailTile";

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
}: {
  playlist: OwnedPlaylist;
  isManaging: boolean;
  onManage: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleValue, setTitleValue] = useState(playlist.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleErrorId = useId();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Menu actions, the delete confirmation and the rename field all unmount
  // the control that had focus; each hands focus back to the options trigger
  // so it does not drop to <body>.
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const update = useUpdatePlaylist();
  const del = useDeletePlaylist();

  const href = `/learn/playlist/${playlist.slug}`;

  const closeRename = () => {
    setRenaming(false);
    triggerRef.current?.focus();
  };

  const submitRename = () => {
    const trimmed = titleValue.trim();
    if (!trimmed) {
      setTitleError("Playlist name can't be empty.");
      return;
    }
    if (trimmed === playlist.title) {
      closeRename();
      return;
    }
    setTitleError(null);
    update.mutate(
      { playlistId: playlist.id, title: trimmed },
      {
        onSuccess: closeRename,
        onError: () => setTitleError("Couldn't rename the playlist — try again."),
      },
    );
  };

  return (
    <div className="group">
      {/* Same shape as the gallery's cards: the thumbnail and the title both
          open the playlist. The thumbnail link is a pointer target only — out
          of the tab order and the accessibility tree — so keyboard and
          screen-reader users get one stop for the playlist (the title), then
          one for its options. The options button sits in the title row, not on
          the thumbnail, so no control is nested inside the link. */}
      <Link
        to={href}
        tabIndex={-1}
        aria-hidden="true"
        className={`relative block aspect-video overflow-hidden rounded-xl bg-slate-900 ${
          isManaging ? "ring-2 ring-pinata-purple" : ""
        }`}
      >
        <ThumbnailTile
          src={playlist.thumbnail ? resolveThumb(playlist.thumbnail) : null}
          alt=""
          fallbackIcon={ListMusic}
          hoverScale
        />
        <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white">
          <ListMusic className="size-3" />
          {playlist.lessonCount}
        </span>
      </Link>

      <div className="mt-3 space-y-2">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  aria-label="Playlist name"
                  aria-invalid={titleError ? true : undefined}
                  aria-describedby={titleError ? titleErrorId : undefined}
                  value={titleValue}
                  onChange={(e) => setTitleValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitRename();
                    if (e.key === "Escape") closeRename();
                  }}
                  maxLength={MAX_TITLE_CHARS}
                  disabled={update.isPending}
                  className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm text-white focus:border-pinata-purple/60 disabled:opacity-60"
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
                  onClick={closeRename}
                  disabled={update.isPending}
                  className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
                >
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <h3 className="text-sm font-semibold leading-snug">
                {/* The two-line clamp (overflow: hidden) sits on the link, not
                    the h3, so an ancestor's overflow cannot clip the focus ring. */}
                <Link
                  to={href}
                  className="line-clamp-2 rounded text-white outline-none hover:underline focus-visible:ring-2 focus-visible:ring-pinata-purple focus-visible:ring-offset-2 focus-visible:ring-offset-[#11141c]"
                >
                  <LangText text={playlist.title} />
                </Link>
                {/* The lesson-count badge sits inside the hidden thumbnail link,
                    so the heading carries the count, after the link: the link's
                    name stays exactly its visible title. */}
                <span className="sr-only">
                  {`, ${playlist.lessonCount} ${playlist.lessonCount === 1 ? "lesson" : "lessons"}`}
                </span>
              </h3>
            )}
          </div>

          <div className="relative shrink-0">
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Playlist options"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="-mr-1.5 -mt-1.5 flex size-8 items-center justify-center rounded-full text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
            >
              <MoreVertical className="size-4" />
            </button>

            <PopoverMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              triggerRef={triggerRef}
              className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-xl border border-white/10 bg-[#11141c] text-left shadow-xl"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  // Focus the trigger first, so the panel takes it as the
                  // place to return focus to, not this unmounting item.
                  triggerRef.current?.focus();
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
            </PopoverMenu>
          </div>
        </div>

        {titleError && (
          <p id={titleErrorId} role="alert" className="text-xs text-rose-300">
            {titleError}
          </p>
        )}
        {deleteError && (
          <p role="alert" className="text-xs text-rose-300">
            {deleteError}
          </p>
        )}

        {confirming === "delete" && (
          <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5">
            <p className="text-xs text-slate-300">
              Delete this playlist permanently? This can't be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => {
                  setConfirming(null);
                  triggerRef.current?.focus();
                }}
                className={ghostButton}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(null);
                  setDeleteError(null);
                  triggerRef.current?.focus();
                  del.mutate(playlist.id, {
                    onError: () => setDeleteError("Couldn't delete the playlist — try again."),
                  });
                }}
                className="rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-rose-700"
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
