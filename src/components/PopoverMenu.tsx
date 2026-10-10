import { useEffect, type ReactNode, type RefObject } from "react";

interface PopoverMenuProps {
  open: boolean;
  /** Called for a click outside the menu and for Escape. */
  onClose: () => void;
  /** The button that toggles the menu; Escape gives focus back to it. */
  triggerRef: RefObject<HTMLElement | null>;
  /** The menu card's classes: its position, width and surface. */
  className?: string;
  children: ReactNode;
}

/**
 * The dropdown behind a "⋮" or avatar button: a role=menu card plus a
 * full-viewport click-outside catcher, closed by a click outside or by Escape,
 * which also returns focus to the trigger. The library cards and the account
 * menu render their items inside it.
 */
export default function PopoverMenu({
  open,
  onClose,
  triggerRef,
  className,
  children,
}: PopoverMenuProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  return (
    <>
      {/* Click-outside catcher: a plain overlay is simpler and more robust
          than a document click listener. Keyboard users close with Escape, so
          it stays out of the tab order and the accessibility tree. */}
      <button
        type="button"
        aria-label="Close menu"
        tabIndex={-1}
        aria-hidden="true"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
      />
      <div role="menu" className={className}>
        {children}
      </div>
    </>
  );
}
