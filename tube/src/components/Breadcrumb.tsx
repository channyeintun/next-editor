import { Link } from "react-router";
import { ChevronRight } from "lucide-react";

// Shared "Lessons > X" trail back to the gallery — used both inside the
// editor's header (the /learn/:slug detail view) and standalone on pages
// that don't render an editor (e.g. /learn/@username).
export default function Breadcrumb({ title }: { title: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs">
      <Link
        to="/learn"
        className="shrink-0 font-bold capitalize tracking-wider text-slate-400 transition-colors hover:text-white"
      >
        Lessons
      </Link>
      <ChevronRight className="size-3.5 shrink-0 text-slate-600" />
      <span className="truncate font-bold capitalize tracking-wider text-slate-200">{title}</span>
    </nav>
  );
}
