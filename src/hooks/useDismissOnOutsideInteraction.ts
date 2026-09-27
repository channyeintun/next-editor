import { useEffect, useEffectEvent, type RefObject } from "react";

export interface DismissOnOutsideInteractionOptions {
  /** Whether the popup is showing. Nothing is listened to while it is not. */
  isOpen: boolean;
  /** The popup, or the popup and its toggle: a pointer-down inside it keeps it open. */
  containerRef: RefObject<HTMLElement | null>;
  /** Closes the popup. */
  onDismiss: () => void;
  /** Whether Escape closes the popup too. */
  dismissOnEscape: boolean;
  /**
   * Where the listeners go, in the bubble phase. The two see different events
   * only when a document listener stops propagation, or when an event is
   * dispatched to the window itself, so each popup keeps the one it had.
   */
  listenOn: "window" | "document";
}

/**
 * Closes a popup (a menu, a context menu) on a pointer-down outside
 * `containerRef` and, when `dismissOnEscape` is set, on Escape.
 */
export function useDismissOnOutsideInteraction({
  isOpen,
  containerRef,
  onDismiss,
  dismissOnEscape,
  listenOn,
}: DismissOnOutsideInteractionOptions) {
  const dismiss = useEffectEvent(onDismiss);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const target: EventTarget = listenOn === "window" ? window : document;
    const handlePointerDown = (event: Event) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        dismiss();
      }
    };
    const handleKeyDown = (event: Event) => {
      if ((event as KeyboardEvent).key === "Escape") {
        dismiss();
      }
    };

    target.addEventListener("pointerdown", handlePointerDown);
    if (dismissOnEscape) {
      target.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      target.removeEventListener("pointerdown", handlePointerDown);
      if (dismissOnEscape) {
        target.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, [containerRef, dismissOnEscape, isOpen, listenOn]);
}
