/**
 * The order rules of the playlist manage panel, kept apart from the panel so
 * they are tested directly: the title sort, a move, and the order the panel
 * shows while its own (already saving) order and the server's members differ.
 */

// Numeric, so "CSS course 2" sorts before "CSS course 10"; base sensitivity,
// so case and accents do not split a course apart.
const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Lessons by title, as a person numbers them: 1, 2, … 10, not 1, 10, 2. */
export function sortByTitle<T extends { title: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => titleCollator.compare(left.title, right.title));
}

/** `items` with the one at `from` moved so it ends up at `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}

/**
 * The members in the panel's own order: those it placed, where it placed them,
 * then any it has not seen yet (just added) in the server's order. A member the
 * server no longer has (just removed) drops out.
 */
export function orderMembers<T extends { id: string }>(
  members: readonly T[],
  localOrder: readonly string[] | null,
): T[] {
  if (!localOrder) return [...members];
  const byId = new Map(members.map((member) => [member.id, member]));
  const placed = localOrder.flatMap((id) => {
    const member = byId.get(id);
    return member ? [member] : [];
  });
  const placedIds = new Set(localOrder);
  return [...placed, ...members.filter((member) => !placedIds.has(member.id))];
}
