import { describe, expect, it } from "vitest";

import { mayTakeFocus } from "./mayTakeFocus";

/**
 * The editor takes the caret when it mounts. That is right in the application
 * and wrong everywhere else the same component can appear — most visibly in an
 * iframe, where a reader who opened kite-lang.dev found the page scrolled down
 * to the embedded lesson because the editor inside it had grabbed focus.
 */
describe("mayTakeFocus", () => {
  const nodeIn = (hasFocus: boolean): HTMLElement =>
    ({ ownerDocument: { hasFocus: () => hasFocus } }) as unknown as HTMLElement;

  it("takes focus in a document the reader is already in", () => {
    expect(mayTakeFocus(nodeIn(true))).toBe(true);
  });

  it("does not take focus in a document that does not have it", () => {
    // An iframe on somebody else's page, a background tab, a page restored
    // from history — all the same question, and all the same answer.
    expect(mayTakeFocus(nodeIn(false))).toBe(false);
  });

  it("does not take focus with no node to ask about", () => {
    expect(mayTakeFocus(null)).toBe(false);
    expect(mayTakeFocus(undefined)).toBe(false);
  });
});
