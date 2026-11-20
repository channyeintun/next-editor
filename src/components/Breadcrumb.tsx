import type { ReactNode } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import LangText from "./LangText";
import BreadcrumbMenu from "./BreadcrumbMenu";

export interface BreadcrumbParent {
  to: string;
  label: string;
}

/**
 * A panel the title crumb opens on hover, or when pressed: e.g. the lessons of
 * the playlist a lesson was opened from. `label` names it.
 */
export interface BreadcrumbTitleMenu {
  label: string;
  content: ReactNode;
}

const GALLERY: BreadcrumbParent = { to: "/learn", label: "Lessons" };

const crumbText = "font-bold capitalize tracking-wider";

// Shared "Lessons > X" trail back to the gallery — used inside the editor's
// header (the /learn/:slug detail view and the /code editor) and standalone
// on pages that don't render an editor (e.g. /learn/@username). A caller with
// a closer parent (a lesson opened from a playlist) passes it as `parent`, and
// the page's siblings (that playlist's lessons) as `menu`, under the title.
export default function Breadcrumb({
  title,
  parent = GALLERY,
  menu,
}: {
  title: string;
  parent?: BreadcrumbParent;
  menu?: BreadcrumbTitleMenu;
}) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs">
      <Link
        to={parent.to}
        className={`min-w-0 max-w-[45%] shrink-0 truncate ${crumbText} text-slate-300 transition-colors hover:text-white`}
      >
        <LangText text={parent.label} />
      </Link>
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-slate-600" />
      {menu ? (
        <BreadcrumbMenu
          crumb={
            <span className={`truncate ${crumbText}`}>
              <LangText text={title} />
            </span>
          }
          label={menu.label}
        >
          {menu.content}
        </BreadcrumbMenu>
      ) : (
        <span aria-current="page" className={`truncate ${crumbText} text-slate-200`}>
          <LangText text={title} />
        </span>
      )}
    </nav>
  );
}
