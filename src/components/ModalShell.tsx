import { useRef, type ReactNode, type RefObject } from "react";
import { useModalFocus } from "../hooks/useModalFocus";

interface ModalShellProps {
  /** How wide the card may grow. */
  maxWidthClassName: "max-w-md" | "max-w-xl";
  /** The id of the element that titles the dialog, usually its heading. */
  labelledBy: string;
  /**
   * Whether the dialog takes over the page (the default): it is then announced
   * as modal, takes focus on open, keeps Tab inside, closes on Escape and gives
   * focus back on close. A dialog that only mirrors a recording during playback
   * passes false, so the player behind it stays reachable.
   */
  modal?: boolean;
  /**
   * Called for a click on the backdrop whose press also started there and,
   * while the dialog is modal, for Escape. A click inside the card never
   * reaches it.
   */
  onDismiss: () => void;
  /** Where focus goes on close, ahead of the element that had it on open. */
  returnFocusTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * The dimmed, blurred full-screen backdrop and the centered card that the
 * editor's settings dialogs are drawn in.
 */
export default function ModalShell({
  maxWidthClassName,
  labelledBy,
  modal = true,
  onDismiss,
  returnFocusTo,
  children,
}: ModalShellProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useModalFocus(cardRef, {
    active: modal,
    onEscape: onDismiss,
    returnFocusTo,
  });
  // A drag that starts in the card and is released on the backdrop still makes
  // the browser click the backdrop, so the press itself has to start there.
  const pressedBackdrop = useRef(false);

  return (
    <div
      className="fixed inset-0 z-50 bg-[#0b0d12]/62 px-4 py-8 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === event.currentTarget) onDismiss();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-labelledby={labelledBy}
        aria-modal={modal ? true : undefined}
        // Focusable only while modal: a click on a playback mirror must leave
        // focus where the player's shortcuts still hear the keys.
        tabIndex={modal ? -1 : undefined}
        className={`mx-auto flex max-h-full w-full ${maxWidthClassName} flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)] outline-none`}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
