import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { PLAYER_SHORTCUTS } from "../hooks/usePlayerShortcuts";

/** The player's keyboard shortcuts, opened with "?" or from the settings. */
export default function PlayerShortcutsHelp({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Focus moves into the help so its opening is heard and Tab starts here, and goes back to
  // whatever opened it ("Keyboard shortcuts" hands focus to Settings before its menu closes).
  // Non-modal: focus is not trapped, and the rest of the page stays reachable.
  useEffect(() => {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    closeRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      className="absolute bottom-full left-1/2 z-46 mb-2 w-80 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-slate-700 bg-[#151821] p-3 text-sm text-slate-200 shadow-[0_18px_40px_rgba(2,6,23,0.45)] pointer-events-auto"
    >
      <div className="mb-2 flex items-center justify-between">
        <p
          id={titleId}
          className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase"
        >
          Keyboard shortcuts
        </p>
        <button
          ref={closeRef}
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
      <p className="mt-1 text-[11px] text-slate-300">
        In the code editor, Tab types a tab. Press Esc, then Tab, to move on.
      </p>
    </div>
  );
}

/**
 * A brief word over the player about what a key just did ("+5 s", "1.25×", "Muted").
 *
 * The status region is always mounted and only its child changes, so screen readers announce
 * each message: a region inserted with its text already inside is often not read. Each press
 * gets a new keyed span, so a repeated "+5 s" is announced again. The visible bubble is a
 * separate node, hidden from assistive technology so the message is not heard twice.
 */
export function PlayerShortcutFeedback({
  feedback,
}: {
  feedback: { text: string; at: number } | null;
}) {
  return (
    <>
      <div role="status" className="sr-only">
        {feedback ? <span key={feedback.at}>{feedback.text}</span> : null}
      </div>
      {feedback ? (
        <div
          key={feedback.at}
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-3 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1 text-sm font-medium text-white shadow"
        >
          {feedback.text}
        </div>
      ) : null}
    </>
  );
}
