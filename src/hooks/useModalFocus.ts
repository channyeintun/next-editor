import { useLayoutEffect, useState, type KeyboardEvent, type RefObject } from "react";
import { isImeComposingKey } from "../utils/keyboardPlatform";

/** What Tab can land on inside a dialog. */
const TABBABLE_SELECTOR = [
  "button:not(:disabled)",
  "[href]",
  'input:not(:disabled):not([type="hidden"])',
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function isGroupedRadio(element: Element | null): element is HTMLInputElement {
  return element instanceof HTMLInputElement && element.type === "radio" && element.name !== "";
}

/** Whether Tab treats the two as one stop: the same element, or radios of one group. */
function isSameStop(focused: Element | null, stop: HTMLElement): boolean {
  if (focused === stop) return true;
  return (
    isGroupedRadio(focused) &&
    isGroupedRadio(stop) &&
    focused.name === stop.name &&
    focused.form === stop.form
  );
}

/** The element Tab lands on for a stop: a radio group's checked radio, when it has one. */
function focusTargetOf(card: HTMLElement, stop: HTMLElement): HTMLElement {
  if (!isGroupedRadio(stop)) return stop;
  const group = [...card.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  return group.find((radio) => radio.checked && isSameStop(radio, stop)) ?? stop;
}

export interface ModalFocusOptions {
  /** Whether the dialog is modal right now. While it is not, the hook does nothing. */
  active: boolean;
  /** Called for Escape pressed inside the dialog. */
  onEscape: () => void;
  /**
   * Where focus goes when the dialog closes. It wins over the element that had
   * focus when the dialog opened, which a menu item that unmounts as it opens
   * the dialog cannot take back.
   */
  returnFocusTo?: RefObject<HTMLElement | null>;
}

/**
 * Focus for a modal dialog drawn without a native `<dialog>`: on open, focus
 * moves to the first control in `cardRef` (or to the card itself, which then
 * needs `tabIndex={-1}`) unless something inside, such as an `autoFocus`
 * child, already has it; Tab and Shift+Tab wrap around inside the card; and on
 * close focus goes back to `returnFocusTo`, else to the element that had it
 * when the dialog opened. The returned `onKeyDown` goes on the card or an
 * ancestor of it; it handles Escape there, without a document listener, so the
 * key never reaches the player's or the editor's shortcuts.
 */
export function useModalFocus(
  cardRef: RefObject<HTMLElement | null>,
  { active, onEscape, returnFocusTo }: ModalFocusOptions,
) {
  // Captured while the dialog first renders: by the time effects run, an
  // autoFocus child has already moved focus into it.
  const [opener] = useState(() => {
    const focused = document.activeElement;
    return focused instanceof HTMLElement && focused !== document.body ? focused : null;
  });

  // A layout effect, so the cleanup puts focus back before React removes the
  // dialog's nodes and the browser drops focus to <body>.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!active || !card) return;

    if (!card.contains(document.activeElement)) {
      const firstStop = card.querySelector<HTMLElement>(TABBABLE_SELECTOR);
      (firstStop ? focusTargetOf(card, firstStop) : card).focus();
    }

    return () => {
      const target = [returnFocusTo?.current, opener].find((element) => element?.isConnected);
      target?.focus();
    };
  }, [active, cardRef, opener, returnFocusTo]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const card = cardRef.current;
    if (!active || !card || event.defaultPrevented) return;

    if (event.key === "Escape") {
      // Escape that ends an IME composition is the input method's.
      if (isImeComposingKey(event.nativeEvent)) return;
      event.stopPropagation();
      onEscape();
      return;
    }

    if (event.key !== "Tab") return;
    const stops = [...card.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)];
    const first = stops[0];
    const last = stops.at(-1);
    if (!first || !last) {
      // Nothing inside takes focus, so it stays on the card.
      event.preventDefault();
      return;
    }

    const focused = document.activeElement;
    const atEdge = event.shiftKey
      ? focused === card || isSameStop(focused, first)
      : isSameStop(focused, last);
    if (atEdge) {
      event.preventDefault();
      focusTargetOf(card, event.shiftKey ? last : first).focus();
    }
  };

  return { onKeyDown };
}
