import { useState } from "react";
import { ListMusic } from "lucide-react";
import type { OwnedPlaylist } from "@next-editor/infra";
import CreatePlaylistModal from "./CreatePlaylistModal";
import PlaylistCard from "./PlaylistCard";
import PlaylistManagePanel from "./PlaylistManagePanel";

const ghostButton =
  "px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400 transition-colors hover:text-white disabled:cursor-default disabled:opacity-60";

// A lightweight management surface for the owner's playlists, mounted inside
// MyLibraryGrid above the lessons grid. Playlists render as YouTube-style
// thumbnail cards in the same grid a LessonCard would use (not a full-width
// list) — reorder/add/remove for whichever one card's menu requests lives in
// a single PlaylistManagePanel below the grid, since a compact card has no
// room for that inline. Only the owner's own PUBLISHED lessons are ever
// addable — playlists are always public (no draft state), so a draft lesson
// must never become reachable through one. (A member unpublished *after*
// being added still shows in the manage panel, tagged as a draft, so it can
// be removed — the public playlist page filters it out.)
export default function PlaylistsSection({ playlists }: { playlists: OwnedPlaylist[] }) {
  const [creating, setCreating] = useState(false);
  const [managingPlaylistId, setManagingPlaylistId] = useState<string | null>(null);

  const managingPlaylist = playlists.find((p) => p.id === managingPlaylistId) ?? null;

  return (
    <div className="mb-8 space-y-3 border-b border-white/10 pb-8">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.06em] text-slate-300">
          <ListMusic className="size-4" />
          Playlists
        </h2>
        <button type="button" onClick={() => setCreating(true)} className={ghostButton}>
          New playlist
        </button>
      </div>

      {creating && <CreatePlaylistModal onClose={() => setCreating(false)} />}

      {playlists.length === 0 ? (
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
          onClose={() => setManagingPlaylistId(null)}
        />
      )}
    </div>
  );
}
