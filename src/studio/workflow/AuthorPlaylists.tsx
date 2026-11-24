import { useEffect } from "react";
import { useMyPlaylists, type OwnedPlaylist } from "@next-editor/infra";

/**
 * Reads the signed-in author's playlists and reports them, rendering nothing.
 * The studio mounts it only where something outside the Workflow tab needs
 * them (an unattended workflow names its playlist by id), so a person's visit
 * does not ask for them before the tab is opened.
 */
export default function AuthorPlaylists({
  onChange,
}: {
  onChange: (playlists: readonly OwnedPlaylist[] | null) => void;
}) {
  const { data } = useMyPlaylists({ fresh: true });
  useEffect(() => {
    onChange(data ?? null);
  }, [data, onChange]);
  return null;
}
