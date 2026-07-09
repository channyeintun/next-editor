import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useCreatePlaylist } from "@next-editor/infra";

const ghostButton =
  "px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400 transition-colors hover:text-white disabled:cursor-default disabled:opacity-60";
const confirmButton =
  "rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-white hover:text-slate-950 disabled:cursor-default disabled:opacity-60";

// Same modal shell as PlaylistManagePanel (and infra/client/upload/
// UploadLessonModal's backdrop/card conventions) — a centered dialog, not an
// inline form pushing the grid down.
export default function CreatePlaylistModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const createPlaylist = useCreatePlaylist();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !createPlaylist.isPending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [createPlaylist.isPending, onClose]);

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
        onSuccess: onClose,
        onError: () => setTitleError("Couldn't create the playlist — try again."),
      },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[#0b0d12]/62 px-4 py-16 backdrop-blur-[2px]"
      onClick={() => !createPlaylist.isPending && onClose()}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
          <h3 className="text-sm font-semibold text-white">New playlist</h3>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={createPlaylist.isPending}
            className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:text-white disabled:opacity-50"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3 p-5">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
            }}
            placeholder="Playlist name"
            disabled={createPlaylist.isPending}
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-pinata-purple/60 disabled:opacity-60"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
            }}
            placeholder="Description (optional)"
            disabled={createPlaylist.isPending}
            className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-pinata-purple/60 disabled:opacity-60"
          />
          {titleError && <p className="text-xs text-rose-300">{titleError}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
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
    </div>
  );
}
