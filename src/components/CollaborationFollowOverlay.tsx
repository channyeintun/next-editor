import { collaborationParticipantColorIndex } from "../collaboration/relativePosition";
import {
  useOptionalCollaboration,
  type CollaborationParticipant,
} from "../contexts/CollaborationContext";
import { collaboratorColor, collaboratorDisplayName } from "./collaboratorAppearance";

function followedSurfaceLabel(
  target: CollaborationParticipant,
  getPathForNodeId: (nodeId: string) => string | null,
): string {
  if (target.surface.kind === "slides") return "Slides";
  if (target.surface.kind === "whiteboard") return "Whiteboard";
  if (!target.surface.fileNodeId) return "Editor";
  const path = getPathForNodeId(target.surface.fileNodeId);
  return path?.split("/").at(-1) ?? "Editor";
}

export default function CollaborationFollowOverlay() {
  const collaboration = useOptionalCollaboration();
  const target = collaboration?.followedParticipant ?? null;
  const name = target ? collaboratorDisplayName(target) : "";
  const surface =
    collaboration && target ? followedSurfaceLabel(target, collaboration.getPathForNodeId) : "";
  const color = target ? collaboratorColor(collaborationParticipantColorIndex(target)) : "";

  return (
    <>
      {/* Announces following, a surface change and stopping. Mounted with the
          room, before following can start, rather than with the follow: a
          status region inserted already filled is often not announced. The
          pill below is the visual copy and stays hidden from assistive
          technology. */}
      {collaboration?.provider ? (
        <p role="status" className="sr-only">
          {target ? `Following ${name}, ${surface}. Press Escape to stop.` : ""}
        </p>
      ) : null}
      {collaboration && target ? (
        <div className="pointer-events-none fixed inset-0 z-2147483645">
          <div className="absolute inset-1 rounded-xl border-2" style={{ borderColor: color }} />
          <div
            className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-slate-950/95 px-3 py-1.5 text-xs font-semibold text-white shadow-xl"
            style={{ borderColor: color }}
          >
            <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
            <span aria-hidden="true">
              Following {name} · {surface} · Esc to stop
            </span>
            <button
              type="button"
              className="pointer-events-auto rounded-full bg-white/10 px-2 py-0.5 text-[10px] hover:bg-white/20"
              onClick={() => collaboration.stopFollowing("user")}
            >
              Stop
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
