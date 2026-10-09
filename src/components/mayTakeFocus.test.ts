import { describe, expect, it } from "vite-plus/test";

import { mayTakeFocus } from "./mayTakeFocus";

/**
 * The editor takes the caret when it mounts and when a lesson starts playing.
 * That is right in the application and wrong everywhere else the same
 * component can appear — most visibly in an iframe, where a reader who opened
 * kite-lang.dev found the page scrolled down to the embedded lesson because the
 * editor inside it had grabbed focus — and wrong whenever the reader has put
 * focus somewhere with the keyboard.
 */
describe("mayTakeFocus", () => {
  const body = { matches: () => false } as unknown as Element;

  /** An element that has focus; `focusVisible` is whether the keyboard placed it. */
  const focused = (focusVisible: boolean): Element =>
    ({
      matches: (selector: string) => selector === ":focus-visible" && focusVisible,
    }) as unknown as Element;

  const nodeIn = (hasFocus: boolean, activeElement: Element | null = body): HTMLElement =>
    ({
      ownerDocument: { hasFocus: () => hasFocus, body, activeElement },
    }) as unknown as HTMLElement;

  it("takes focus in a document the reader is already in, with focus on the page", () => {
    expect(mayTakeFocus(nodeIn(true))).toBe(true);
    expect(mayTakeFocus(nodeIn(true, null))).toBe(true);
  });

  it("does not take focus in a document that does not have it", () => {
    // An iframe on somebody else's page, a background tab, a page restored
    // from history — all the same question, and all the same answer.
    expect(mayTakeFocus(nodeIn(false))).toBe(false);
  });

  it("does not take focus the reader placed with the keyboard", () => {
    // A header link tabbed to while the editor's chunk loaded, or Play
    // pressed with Space or Enter: focus stays where the reader put it.
    expect(mayTakeFocus(nodeIn(true, focused(true)))).toBe(false);
  });

  it("takes focus from a button the reader clicked with the mouse", () => {
    // Chrome focuses a clicked <button> without :focus-visible; pressing Play
    // that way still moves the replayed caret into view in the editor.
    expect(mayTakeFocus(nodeIn(true, focused(false)))).toBe(true);
  });

  it("leaves focus alone when the browser cannot say how it was placed", () => {
    const unsupported = {
      matches: () => {
        throw new SyntaxError("unknown pseudo-class");
      },
    } as unknown as Element;

    expect(mayTakeFocus(nodeIn(true, unsupported))).toBe(false);
  });

  it("does not take focus with no node to ask about", () => {
    expect(mayTakeFocus(null)).toBe(false);
    expect(mayTakeFocus(undefined)).toBe(false);
  });
});
