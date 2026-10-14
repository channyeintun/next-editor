import type { LucideIcon } from "lucide-react";

/**
 * A player menu row's leading icon, in a fixed 16px column so every row's label starts at
 * the same place. Quieter than its label, it brightens with its row: the row is the
 * `group/row` it sits in.
 */
export default function MenuRowIcon({
  icon: Icon,
  className = "",
}: {
  icon: LucideIcon;
  /** Added to the icon itself, as `animate-spin` for a loader. */
  className?: string;
}) {
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center text-slate-400 transition-colors group-hover/row:text-slate-200"
      aria-hidden="true"
    >
      <Icon size={16} className={className} />
    </span>
  );
}
