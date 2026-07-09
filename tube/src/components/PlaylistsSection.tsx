import { useState } from "react";
import { ListMusic } from "lucide-react";
import { useCreatePlaylist, type OwnedLesson, type OwnedPlaylist } from "@next-editor/infra";
import PlaylistCard from "./PlaylistCard";
import PlaylistManagePanel from "./PlaylistManagePanel";

const ghostButton =
  "px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400 transition-colors hover:text-white disabled:cursor-default disabled:opacity-60";
const confirmButton =
  "rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-white hover:text-slate-950";

// A lightweight management surface for the owner's playlists, mounted inside
// MyLibraryGrid above the lessons grid. Playlists render as YouTube-style
// thumbnail cards in the same grid a LessonCard would use (not a full-width
// list) — reorder/add/remove for whichever one card's menu requests lives in
// a single PlaylistManagePanel below the grid, since a compact card has no
// room for that inline. Only the owner's own PUBLISHED lessons are ever
// addable — playlists are always public (no draft state), so a draft lesson
// must never become reachable through one.
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
  const [managingPlaylistId, setManagingPlaylistId] = useState<string | null>(null);
  const createPlaylist = useCreatePlaylist();

  const publishedLessons = lessons.filter((l) => l.status === "published");
  const managingPlaylist = playlists.find((p) => p.id === managingPlaylistId) ?? null;

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
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {playlists.map((playlist) => (
            <PlaylistCard
              key={playlist.id}
              playlist={playlist}
              isManaging={playlist.id === managingPlaylistId}
              onManage={() => setManagingPlaylistId(playlist.id)}
              onDeleted={() => {
                if (managingPlaylistId === playlist.id) setManagingPlaylistId(null);
              }}
            />
          ))}
        </div>
      )}

      {managingPlaylist && (
        <PlaylistManagePanel
          playlist={managingPlaylist}
          publishedLessons={publishedLessons}
          onClose={() => setManagingPlaylistId(null)}
        />
      )}
    </div>
  );
}
