import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import HoverRing from "./hoverRing/HoverRing";

/** How long the pointer rests on the crumb before its panel opens. */
const OPEN_DELAY_MS = 150;
/** How long the panel waits after the pointer leaves, so it can cross to the panel. */
const CLOSE_DELAY_MS = 300;

/** What opened the panel: the pointer resting on the crumb, or a press of it (click, tap or key). */
type OpenBy = "hover" | "toggle";

/**
 * The trail's current crumb (the page's own title) with a panel under it. The
 * crumb is not a link, so the whole of it is the toggle: resting the pointer
 * on it opens the panel, and pressing it opens it for the keyboard and for
 * touch, where there is no hover. It is a disclosure button (aria-expanded),
 * with the panel right after it, so Tab goes on into it.
 *
 * Content shown on hover follows WCAG 1.4.13: Escape dismisses it without
 * moving the pointer; the pointer can move onto it (it sits flush under the
 * crumb and waits before closing); and it stays until the pointer leaves, focus
 * leaves, Escape, or a press outside. Opened with a press, it stays until
 * another press, Escape, a press outside or focus leaving closes it. Following
 * a link in the panel closes it too.
 */
export default function BreadcrumbMenu({
  crumb,
  label,
  children,
}: {
  /** The crumb's text: the page's title. It goes inside the toggle, so no links or buttons. */
  crumb: ReactNode;
  /** Names the panel, and follows the title in the toggle's name, e.g. "Lessons in Go from zero". */
  label: string;
  /** The panel's contents. */
  children: ReactNode;
}) {
  const [openBy, setOpenBy] = useState<OpenBy | null>(null);
  const open = openBy !== null;
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Set by Escape: the pointer still resting on the crumb must not reopen it.
  const dismissedRef = useRef(false);

  const later = (action: () => void, ms: number) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(action, ms);
  };
  const close = () => {
    clearTimeout(timerRef.current);
    setOpenBy(null);
  };

  useEffect(() => {
    const timers = timerRef;
    return () => clearTimeout(timers.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      clearTimeout(timerRef.current);
      setOpenBy(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dismissedRef.current = true;
      // Focus in the panel would be left on nothing; give it to the toggle.
      const hadFocus = rootRef.current?.contains(document.activeElement) ?? false;
      dismiss();
      if (hadFocus) toggleRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) dismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative flex min-w-0 items-center"
      onPointerEnter={(event) => {
        // Touch has no hover: a tap presses the toggle.
        if (event.pointerType === "touch" || dismissedRef.current) return;
        if (open) clearTimeout(timerRef.current);
        else later(() => setOpenBy("hover"), OPEN_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        dismissedRef.current = false;
        if (openBy === "hover") later(close, CLOSE_DELAY_MS);
        else clearTimeout(timerRef.current);
      }}
      onFocus={(event) => {
        // Focus that reaches a hover-opened panel keeps it open when the pointer leaves.
        if (openBy === "hover" && (event.target as Node) !== toggleRef.current) {
          setOpenBy("toggle");
        }
      }}
      onBlur={(event) => {
        // Focus moving elsewhere on the page closes it; the window losing focus does not.
        const next = event.relatedTarget;
        if (open && next instanceof Node && !rootRef.current?.contains(next)) close();
      }}
    >
      {/* Padded for the ring, pulled back by the same, so the title stays where
          a crumb without a panel has it. */}
      <button
        ref={toggleRef}
        type="button"
        aria-current="page"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          clearTimeout(timerRef.current);
          // A panel the pointer opened stays open: the press pins it.
          setOpenBy(openBy === "toggle" ? null : "toggle");
        }}
        className="relative -mx-1 flex h-6 min-w-0 items-center gap-0.5 rounded px-1 text-slate-200 transition-colors hover:text-white aria-expanded:text-white"
      >
        {crumb}
        {/* One text node with its separator, after the title the name starts
            with (WCAG 2.5.3): "Variables, Lessons in Go from zero". */}
        <span className="sr-only">{`, ${label}`}</span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
        <HoverRing />
      </button>

      {open ? (
        // Flush under the crumb, its gap as padding, so the pointer moving down
        // onto it never leaves the crumb. On phones it spans the screen. Above
        // the player's floating play button (z-110).
        <div
          id={panelId}
          role="group"
          aria-label={label}
          onClick={(event) => {
            if ((event.target as Element).closest("a[href]")) close();
          }}
          className="fixed inset-x-4 top-11 z-120 sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:pt-1.5"
        >
          <div className="overflow-hidden rounded-lg border border-slate-700 bg-[#151821] text-sm shadow-[0_18px_40px_rgba(2,6,23,0.45)] sm:w-80">
            {children}
          </div>
        </div>
      ) : null}
    </div>
  );
}
