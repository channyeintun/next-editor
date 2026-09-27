// How a collaborator — a room member, or one of their live sessions — appears
// to everyone else: the name shown for them and the colour their cursor,
// selection, presence dot and follow frame are drawn in. Which colour a
// participant gets is collaborationParticipantColorIndex's job, so every
// surface that indexes these lists agrees on it.

/** A collaborator's account name, or their username when the name is blank. */
export function collaboratorDisplayName(person: { name: string | null; username: string }): string {
  return person.name?.trim() || person.username;
}

// One entry per collaborationParticipantColorIndex value. App.css repeats the
// first two lists in its `.collaboration-color-N` rules (the cursors, selections
// and name labels CodeEditor decorates Monaco with), so change them together.
const COLLABORATOR_COLORS = [
  "#38bdf8",
  "#34d399",
  "#fbbf24",
  "#e879f9",
  "#22d3ee",
  "#fb923c",
  "#a78bfa",
  "#a3e635",
] as const;
const COLLABORATOR_SELECTION_COLORS = [
  "rgb(56 189 248 / 28%)",
  "rgb(52 211 153 / 28%)",
  "rgb(251 191 36 / 28%)",
  "rgb(232 121 249 / 28%)",
  "rgb(34 211 238 / 28%)",
  "rgb(251 146 60 / 28%)",
  "rgb(167 139 250 / 28%)",
  "rgb(163 230 53 / 28%)",
] as const;

/**
 * The same hues as Tailwind background classes, for the dot beside a
 * participant who has no avatar. They are Tailwind's own `-400` shades, which
 * Tailwind 4 defines in OKLCH, so they are close to the colours above but not
 * the same values. Callers index this list directly, with no fallback.
 */
export const COLLABORATOR_DOT_CLASSES = [
  "bg-sky-400",
  "bg-emerald-400",
  "bg-amber-400",
  "bg-fuchsia-400",
  "bg-cyan-400",
  "bg-orange-400",
  "bg-violet-400",
  "bg-lime-400",
] as const;

/** A collaborator's colour, or the first colour for an index outside the list. */
export function collaboratorColor(colorIndex: number): string {
  return COLLABORATOR_COLORS[colorIndex] ?? COLLABORATOR_COLORS[0];
}

/** A collaborator's colour at 28% opacity, for text they have selected. */
export function collaboratorSelectionColor(colorIndex: number): string {
  return COLLABORATOR_SELECTION_COLORS[colorIndex] ?? COLLABORATOR_SELECTION_COLORS[0];
}
