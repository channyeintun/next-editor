import { useState } from "react";
import { Link } from "react-router";
import { ListMusic } from "lucide-react";
import type { PlaylistSummary } from "@next-editor/infra";

// Read-only playlist card for the public author profile — the same thumbnail
// + lesson-count visual as the owner's PlaylistCard, but with no manage menu
// (a visitor can only open the playlist, not rename/reorder/delete it).
export default function PlaylistSummaryCard({ playlist }: { playlist: PlaylistSummary }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const href = `/learn/playlist/${playlist.slug}`;

  return (
    <div className="group">
      <Link
        to={href}
        tabIndex={-1}
        aria-hidden="true"
        className="relative block aspect-video overflow-hidden rounded-xl bg-slate-900"
      >
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
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        )}
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
            {playlist.title}
          </Link>
        </h3>
      </div>
    </div>
  );
}
