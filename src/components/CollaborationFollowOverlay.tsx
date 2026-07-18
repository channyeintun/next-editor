import { collaborationParticipantColorIndex } from "../collaboration/relativePosition";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";

const FOLLOW_COLORS = [
  "#38bdf8",
  "#34d399",
  "#fbbf24",
  "#e879f9",
  "#22d3ee",
  "#fb923c",
  "#a78bfa",
  "#a3e635",
] as const;

function displayName(person: { name: string | null; username: string }): string {
  return person.name?.trim() || person.username;
}

export default function CollaborationFollowOverlay() {
  const collaboration = useOptionalCollaboration();
  const target = collaboration?.followedParticipant;
  if (!collaboration || !target) return null;

  const surface = (() => {
    if (target.surface.kind === "slides") return "Slides";
    if (target.surface.kind === "whiteboard") return "Whiteboard";
    if (!target.surface.fileNodeId) return "Editor";
    const path = collaboration.getPathForNodeId(target.surface.fileNodeId);
    return path?.split("/").at(-1) ?? "Editor";
  })();
  const color = FOLLOW_COLORS[collaborationParticipantColorIndex(target)] ?? FOLLOW_COLORS[0];

  return (
    <div className="pointer-events-none fixed inset-0 z-2147483645" aria-live="polite">
      <div className="absolute inset-1 rounded-xl border-2" style={{ borderColor: color }} />
      <div
        role="status"
        className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-slate-950/95 px-3 py-1.5 text-xs font-semibold text-white shadow-xl"
        style={{ borderColor: color }}
      >
        <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
        <span>
          Following {displayName(target)} · {surface} · Esc to stop
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
  );
}
