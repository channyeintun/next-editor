import type { ReactNode } from "react";
import { DEFAULT_FILE_SIDEBAR_WIDTH, readStoredFileSidebarCollapsed } from "../utils/sidebarLayout";

// Structural stand-in for the editor chrome (header, file sidebar, code surface,
// player bar). The real chrome lives inside the lazily-loaded CodeEditor chunk —
// which statically pulls in Monaco — so until that chunk lands there is literally
// nothing of the page to show. Without this, every gate on the way to a lesson
// (route chunk → lesson lookup → CodeEditor/Monaco) renders a bare centered
// spinner on an otherwise empty page, and the whole UI pops in at once at the end.
//
// Deliberately dependency-free (no contexts, no stores): it is rendered from the
// router's HydrateFallback, so it has to sit in the eager bundle and cannot
// assume any provider is mounted.

const CODE_LINES: readonly { indent: number; width: string }[] = [
  { indent: 0, width: "38%" },
  { indent: 0, width: "52%" },
  { indent: 0, width: "26%" },
  { indent: 1, width: "61%" },
  { indent: 1, width: "44%" },
  { indent: 2, width: "48%" },
  { indent: 2, width: "33%" },
  { indent: 1, width: "56%" },
  { indent: 0, width: "22%" },
  { indent: 0, width: "45%" },
  { indent: 1, width: "58%" },
  { indent: 1, width: "36%" },
  { indent: 2, width: "41%" },
  { indent: 1, width: "29%" },
  { indent: 0, width: "18%" },
];

const FILE_ROWS: readonly { indent: number; width: string }[] = [
  { indent: 0, width: "62%" },
  { indent: 1, width: "48%" },
  { indent: 1, width: "56%" },
  { indent: 1, width: "38%" },
  { indent: 0, width: "44%" },
  { indent: 0, width: "58%" },
  { indent: 0, width: "34%" },
];

export interface EditorShellSkeletonProps {
  /** Real breadcrumb when the caller already knows the lesson title; a shimmer
   *  placeholder stands in for it otherwise. */
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
      <div className="flex items-center justify-between px-4 py-1.5" aria-hidden="true">
        <div className="flex min-w-0 items-center gap-2">
          <div className="size-8 shrink-0 rounded-lg bg-white/5" />
          {breadcrumb ?? <div className="h-3 w-40 animate-pulse rounded bg-slate-800" />}
        </div>
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-lg bg-white/5" />
          <div className="size-8 rounded-lg bg-white/5" />
          <div className="mx-1 h-4 w-px bg-slate-700" />
          <div className="size-8 rounded-lg bg-white/5" />
          <div className="size-8 rounded-lg bg-white/5" />
          <div className="size-8 rounded-lg bg-white/5" />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden" aria-hidden="true">
        {sidebarCollapsed ? null : (
          <aside
            className="flex h-full shrink-0 flex-col overflow-hidden"
            style={{ width: DEFAULT_FILE_SIDEBAR_WIDTH }}
          >
            <div className="border-b border-slate-800 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Files
              </p>
            </div>
            <div className="animate-pulse space-y-2.5 p-3">
              {FILE_ROWS.map((row, index) => (
                <div
                  className="flex items-center gap-2"
                  key={index}
                  style={{ paddingLeft: row.indent * 14 }}
                >
                  <div className="size-3.5 shrink-0 rounded-sm bg-slate-800" />
                  <div className="h-3 rounded bg-slate-800" style={{ width: row.width }} />
                </div>
              ))}
            </div>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden">
          <div className="min-h-0 flex-1 overflow-hidden rounded-t-md bg-[#181d24]">
            <div className="animate-pulse space-y-3 px-6 py-4">
              {CODE_LINES.map((line, index) => (
                <div
                  className="h-3 rounded bg-white/5"
                  key={index}
                  style={{ marginLeft: line.indent * 24, width: line.width }}
                />
              ))}
            </div>
          </div>
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
