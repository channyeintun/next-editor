import { Link } from "react-router";
import { ListMusic } from "lucide-react";
import LangText from "@app/components/LangText";
import type { PlaylistSummary } from "@next-editor/infra";
import { playlistHref, resolveThumb } from "../lib/links";
import CardAuthor from "./CardAuthor";
import ThumbnailTile from "./ThumbnailTile";

// Read-only playlist card for the public pages: the gallery, where it stands
// in for the lessons the playlist holds, the author profile and search. The
// same thumbnail + lesson-count visual as the owner's PlaylistCard, but with no
// manage menu (a visitor can only open the playlist, not rename/reorder/delete
// it).
export default function PlaylistSummaryCard({
  playlist,
  priority = false,
}: {
  playlist: PlaylistSummary;
  /** In the first row on screen: its cover is the page's LCP candidate, so it
   *  loads at once and at high priority instead of lazily. */
  priority?: boolean;
}) {
  const href = playlistHref(playlist.slug);
  const lessons = `${playlist.lessonCount} ${playlist.lessonCount === 1 ? "lesson" : "lessons"}`;

  return (
    <div className="group">
      <Link
        to={href}
        tabIndex={-1}
        aria-hidden="true"
        className="relative block aspect-video overflow-hidden rounded-xl bg-slate-900"
      >
        <ThumbnailTile
          src={playlist.thumbnail ? resolveThumb(playlist.thumbnail) : null}
          alt=""
          fallbackIcon={ListMusic}
          priority={priority}
          hoverScale
        />
        <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white">
          <ListMusic className="size-3" />
          {playlist.lessonCount}
        </span>
      </Link>

      <div className="mt-3">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug">
          <Link
            to={href}
            className="rounded text-white outline-none hover:underline focus-visible:ring-2 focus-visible:ring-pinata-purple focus-visible:ring-offset-2 focus-visible:ring-offset-[#11141c]"
          >
            <LangText text={playlist.title} />
            <span className="sr-only">{`, ${lessons}`}</span>
          </Link>
        </h3>
        {/* The gallery's cards are of many authors, so a playlist there names
            its own, where a lesson card has its author and date. The count is
            spelled out beside it for sighted readers only: the title link
            above already reads it out. Same slate-300 as the lesson card. */}
        {playlist.author && (
          <p className="mt-1 text-xs text-slate-300">
            <CardAuthor name={playlist.author} url={playlist.authorUrl} />
            <span aria-hidden="true"> · {lessons}</span>
          </p>
        )}
      </div>
    </div>
  );
}
