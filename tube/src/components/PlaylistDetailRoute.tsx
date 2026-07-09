import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import Navbar from "@app/components/Navbar";
import { AuthMenu } from "@next-editor/infra";
import LoadingSpinner from "@app/components/LoadingSpinner";
import { usePlaylist } from "../hooks/usePlaylists";
import PlaylistDetail from "./PlaylistDetail";

// Route component for /learn/playlist/:slug. Unlike LessonDetailRoute (which
// renders the embedded Editor — a lesson IS playable content), a playlist is
// just an ordered shelf of lesson cards, so this gets its own Navbar shell
// like AuthorProfilePage rather than reusing LessonDetail's Editor wrapper.
export default function PlaylistDetailRoute() {
  const { slug } = useParams();
  const { data: playlist, isPending, isError } = usePlaylist(slug);

  return (
    <Shell>
      {isPending ? (
        <div className="flex justify-center py-20">
          <LoadingSpinner />
        </div>
      ) : playlist ? (
        <PlaylistDetail playlist={playlist} />
      ) : (
        <div className="flex flex-col items-center gap-4 py-20 text-center text-slate-400">
          <p className="text-sm">{isError ? "Failed to load playlist." : "Playlist not found."}</p>
          <Link
            to="/learn"
            className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
          >
            Back to lessons
          </Link>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-[#11141c] font-telegraf text-white selection:bg-pinata-purple selection:text-white">
      <Navbar minimal actions={<AuthMenu />} />
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 pb-20 pt-2 sm:px-8">{children}</main>
    </div>
  );
}
