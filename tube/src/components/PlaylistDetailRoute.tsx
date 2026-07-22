import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import Navbar from "@app/components/Navbar";
import { AuthMenu } from "@next-editor/infra";
import { usePlaylist } from "../hooks/usePlaylists";
import PlaylistDetail from "./PlaylistDetail";
import LessonCardSkeleton from "./LessonCardSkeleton";

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
        <PlaylistDetailSkeleton />
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

// Mirrors PlaylistDetail's header + card grid so the layout doesn't jump when
// the real content loads in.
function PlaylistDetailSkeleton() {
  return (
    <div className="py-4" aria-hidden="true">
      {/* Breadcrumb row (text-xs nav) */}
      <div className="h-4 w-48 animate-pulse rounded bg-slate-800" />
      <div className="animate-pulse py-6">
        {/* "Playlist · N lessons" eyebrow */}
        <div className="h-3.5 w-40 rounded bg-slate-800" />
        {/* Title (text-2xl) */}
        <div className="mt-1.5 h-8 w-2/3 max-w-md rounded bg-slate-800" />
        {/* Description */}
        <div className="mt-2 h-4 w-full max-w-2xl rounded bg-slate-800" />
      </div>
      <div className="grid grid-cols-1 gap-5 pb-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <LessonCardSkeleton key={i} />
        ))}
      </div>
    </div>
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
