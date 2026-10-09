import type { LucideIcon } from "lucide-react";

/**
 * A pill beside the audio source that switches something else the next take records, such as
 * the camera or the screen, on or off.
 */
const RecordingOptionToggle = ({
  tour,
  label,
  on,
  onToggle,
  icon,
  title,
}: {
  /** The product tour's anchor for this option. */
  tour: string;
  label: string;
  on: boolean;
  onToggle: () => void;
  icon: { on: LucideIcon; off: LucideIcon };
  title: { on: string; off: string };
}) => {
  const OnIcon = icon.on;
  const OffIcon = icon.off;
  return (
    <button
      data-tour={tour}
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      // The name stays the label when narrow screens hide it; the title describes the state.
      aria-label={label}
      title={on ? title.on : title.off}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold shadow-sm transition-colors ${
        on
          ? "border-pinata-cyan bg-pinata-cyan text-slate-950"
          : "border-slate-700 bg-slate-900/90 text-slate-400 hover:bg-slate-800 hover:text-white"
      }`}
    >
      {on ? <OnIcon size={13} aria-hidden="true" /> : <OffIcon size={13} aria-hidden="true" />}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
};

export default RecordingOptionToggle;
