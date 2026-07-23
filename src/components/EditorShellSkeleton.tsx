import type { ReactNode } from "react";
import {
  FilePlus2,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  PenTool,
  Presentation,
  Settings,
  Upload,
  Users,
} from "lucide-react";
import { DEFAULT_FILE_SIDEBAR_WIDTH, readStoredFileSidebarCollapsed } from "../utils/sidebarLayout";

// Structural stand-in for the editor chrome (header, file sidebar, code surface,
// player bar). The real chrome lives inside the lazily-loaded CodeEditor chunk —
// which statically pulls in Monaco — so until that chunk lands there is literally
// nothing of the page to show. Without this, every gate on the way to a lesson
// (route chunk → lesson lookup → CodeEditor/Monaco) renders a bare centered
// spinner on an otherwise empty page, and the whole UI pops in at once at the end.
//
// The header and sidebar chrome are static copies of the real elements (same
// icons, labels, and geometry as EditorHeader/FileSidebar) so they don't flash
// from placeholder boxes to icons when the real chunk lands — only inert, so
// nothing here is focusable or announces as a control. The file list and code
// surface stay empty: the real ones start empty too.
//
// Deliberately dependency-free (no contexts, no stores): it is rendered from the
// router's HydrateFallback, so it has to sit in the eager bundle and cannot
// assume any provider is mounted.

const HEADER_ICON_CLASS =
  "inline-flex size-8 items-center justify-center rounded-lg text-slate-400";

export interface EditorShellSkeletonProps {
  /** Real breadcrumb when the caller already knows the lesson title; the
   *  header's static "Editor" label stands in for it otherwise. */
  breadcrumb?: ReactNode;
  /** Fill the parent (`h-full`) instead of the viewport (`h-dvh`) — matches the
   *  same prop on Editor/CodeEditor so the skeleton can stand in for either. */
  fill?: boolean;
  /** Reserve the player bar. Off when this stands in for CodeEditor alone, since
   *  the real MediaControls renders as its sibling. */
  showPlayerBar?: boolean;
}

export default function EditorShellSkeleton({
  breadcrumb,
  fill = false,
  showPlayerBar = false,
}: EditorShellSkeletonProps) {
  const sidebarCollapsed = readStoredFileSidebarCollapsed();

  return (
    <div
      aria-label="Loading editor"
      className={`${fill ? "h-full" : "h-dvh"} flex flex-col overflow-hidden bg-[#11141c] text-white`}
      role="status"
    >
      <div className="bg-[#11141c] px-4 py-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div aria-hidden="true" className={HEADER_ICON_CLASS}>
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </div>
          {breadcrumb ?? (
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Editor
            </span>
          )}
        </div>
        <div className="flex items-center gap-2" aria-hidden="true">
          <div className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-400">
            <Users size={15} />
            <span>Live</span>
          </div>
          <div className={HEADER_ICON_CLASS}>
            <Settings size={16} />
          </div>
          <div className="h-4 w-px bg-slate-700 mx-1" />
          <div className="flex items-center gap-2">
            <div className={HEADER_ICON_CLASS}>
              <PenTool size={16} />
            </div>
            <div className="flex h-8 items-center rounded-lg px-2.5 text-slate-400">
              <Presentation className="size-4" />
            </div>
            <div className={HEADER_ICON_CLASS}>
              <PanelRightOpen size={16} />
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden" aria-hidden="true">
        {sidebarCollapsed ? null : (
          <aside
            className="flex h-full shrink-0 flex-col overflow-hidden"
            style={{ width: DEFAULT_FILE_SIDEBAR_WIDTH }}
          >
            <div className="border-b border-slate-800 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Files
                </p>
                <div className="flex items-center gap-1 text-slate-400">
                  <span className="inline-flex size-5 items-center justify-center">
                    <FilePlus2 size={14} />
                  </span>
                  <span className="inline-flex size-5 items-center justify-center">
                    <FolderPlus size={14} />
                  </span>
                  <span className="inline-flex size-5 items-center justify-center">
                    <Upload size={14} />
                  </span>
                </div>
              </div>
            </div>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden">
          <div className="min-h-0 flex-1 rounded-t-md bg-[#181d24]" />
        </div>
      </div>

      {showPlayerBar ? <EditorPlayerBarSkeleton /> : null}
    </div>
  );
}

// Placeholder for MediaControls, which renders nothing at all until a recording
// is loaded. Mirrors its geometry (border, padding, min-h-8 row) so the bar is
// there from the first paint and the code surface doesn't resize under the
// viewer when the real controls take over.
export function EditorPlayerBarSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="relative w-full max-h-10 border-t border-[#0f131a] bg-[#11141c] px-4 py-1"
    >
      <div className="flex min-h-8 w-full items-center gap-3">
        <div className="size-6 shrink-0 rounded-full bg-white/5" />
        <div className="h-1 flex-1 rounded-full bg-white/5" />
        <div className="h-3 w-20 shrink-0 rounded bg-white/5" />
      </div>
    </div>
  );
}
