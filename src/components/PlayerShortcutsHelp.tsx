import { useEffect } from "react";
import { X } from "lucide-react";
import { PLAYER_SHORTCUTS } from "../hooks/usePlayerShortcuts";

/** The player's keyboard shortcuts, opened with "?" or from the settings. */
export default function PlayerShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="absolute bottom-full left-1/2 z-46 mb-2 w-80 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-slate-700 bg-[#151821] p-3 text-sm text-slate-200 shadow-[0_18px_40px_rgba(2,6,23,0.45)] pointer-events-auto"
    >
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
          Keyboard shortcuts
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close keyboard shortcuts"
          className="text-slate-500 transition-colors hover:text-white"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5">
        {PLAYER_SHORTCUTS.map(({ keys, action }) => (
          <div key={action} className="contents">
            <dt className="flex gap-1 justify-self-end">
              {keys.map((key) => (
                <kbd
                  key={key}
                  className="min-w-6 rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-center font-mono text-[11px] text-slate-200"
                >
                  {key}
                </kbd>
              ))}
            </dt>
            <dd className="text-xs text-slate-300">{action}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-slate-500">
        Keys go to the player when you are not typing in the editor, terminal, or a field.
        Single-key shortcuts (letters, numbers and punctuation) can be turned off in Settings.
      </p>
    </div>
  );
}

/** A brief word over the player about what a key just did ("+5 s", "1.25×", "Muted"). */
export function PlayerShortcutFeedback({ text }: { text: string }) {
  return (
    <div
      role="status"
      className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-3 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1 text-sm font-medium text-white shadow"
    >
      {text}
    </div>
  );
}
