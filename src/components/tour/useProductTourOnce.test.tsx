import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  startTour: vi.fn<(options?: { force?: boolean }) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("./productTour", () => ({ startTour: mocks.startTour }));

import {
  authorHoldsFocus,
  type ProductTourOnceOptions,
  useAuthorInteractionFlag,
  useProductTourOnce,
} from "./useProductTourOnce";

/**
 * The first-run tour moves focus into its popover. It may do that only while
 * the author holds nothing: not after a key or pointer press, and not from a
 * control they tabbed to — but over the code editor's own mount focus, which
 * the app placed, it still starts (WCAG 3.0 2.4.1 "Focus user-controlled").
 */
describe("authorHoldsFocus", () => {
  const body = { matches: () => false, closest: () => null } as unknown as Element;

  const element = ({
    focusVisible,
    inEditor = false,
  }: {
    focusVisible: boolean;
    inEditor?: boolean;
  }): Element =>
    ({
      matches: (selector: string) => selector === ":focus-visible" && focusVisible,
      closest: (selector: string) => (selector === ".monaco-editor" && inEditor ? {} : null),
    }) as unknown as Element;

  const docWith = (activeElement: Element | null): Document =>
    ({ activeElement, body }) as unknown as Document;

  it("holds focus once the author has pressed a key or a pointer", () => {
    expect(authorHoldsFocus(docWith(body), true)).toBe(true);
  });

  it("holds nothing while focus is on the page itself", () => {
    expect(authorHoldsFocus(docWith(null), false)).toBe(false);
    expect(authorHoldsFocus(docWith(body), false)).toBe(false);
  });

  it("does not count the code editor's own mount focus", () => {
    const editorInput = element({ focusVisible: true, inEditor: true });
    expect(authorHoldsFocus(docWith(editorInput), false)).toBe(false);
  });

  it("holds a control tabbed to from the browser's address bar", () => {
    // No in-page keydown fires for that Tab; :focus-visible is the only trace.
    expect(authorHoldsFocus(docWith(element({ focusVisible: true })), false)).toBe(true);
  });

  it("holds nothing on a control focused without the keyboard and without a press", () => {
    expect(authorHoldsFocus(docWith(element({ focusVisible: false })), false)).toBe(false);
  });

  it("holds focus when the browser cannot say how it was placed", () => {
    const unsupported = {
      matches: () => {
        throw new SyntaxError("':focus-visible' is not a valid selector");
      },
      closest: () => null,
    } as unknown as Element;
    expect(authorHoldsFocus(docWith(unsupported), false)).toBe(true);
  });
});

describe("useProductTourOnce", () => {
  const originalMatches = Element.prototype.matches;
  /** The element the keyboard placed focus on, as :focus-visible reports it. */
  let keyboardFocused: Element | null = null;

  const props = (overrides: Partial<ProductTourOnceOptions> = {}): ProductTourOnceOptions => ({
    recordingLoading: false,
    loadError: null,
    readOnly: false,
    authorInteracted: { current: false },
    ...overrides,
  });

  beforeEach(() => {
    mocks.startTour.mockClear();
    document.body.innerHTML = "";
    keyboardFocused = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    // jsdom's :focus-visible heuristic is not a browser's; decide it per test.
    vi.spyOn(Element.prototype, "matches").mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      return selector === ":focus-visible"
        ? this === keyboardFocused
        : originalMatches.call(this, selector);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("starts the tour once on a fresh load", () => {
    const { rerender } = renderHook((options) => useProductTourOnce(options), {
      initialProps: props(),
    });
    expect(mocks.startTour).toHaveBeenCalledOnce();
    expect(mocks.startTour).toHaveBeenCalledWith();

    rerender(props());
    expect(mocks.startTour).toHaveBeenCalledOnce();
  });

  it("leaves the tour unstarted once the author has interacted", () => {
    const authorInteracted = { current: true };
    const { rerender } = renderHook((options) => useProductTourOnce(options), {
      initialProps: props({ authorInteracted }),
    });
    expect(mocks.startTour).not.toHaveBeenCalled();

    // One attempt per mount: no retry later in the same load.
    rerender(props({ authorInteracted }));
    expect(mocks.startTour).not.toHaveBeenCalled();
  });

  it("does not take focus from a control the author tabbed to", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    keyboardFocused = button;

    renderHook((options) => useProductTourOnce(options), { initialProps: props() });
    expect(mocks.startTour).not.toHaveBeenCalled();
  });

  it("starts over the code editor's own mount focus", () => {
    document.body.innerHTML =
      '<div class="monaco-editor"><textarea class="inputarea"></textarea></div>';
    const textarea = document.querySelector("textarea")!;
    textarea.focus();
    keyboardFocused = textarea;

    renderHook((options) => useProductTourOnce(options), { initialProps: props() });
    expect(mocks.startTour).toHaveBeenCalledOnce();
  });

  it("waits for the recording to load", () => {
    const { rerender } = renderHook((options) => useProductTourOnce(options), {
      initialProps: props({ recordingLoading: true }),
    });
    expect(mocks.startTour).not.toHaveBeenCalled();

    rerender(props({ recordingLoading: false }));
    expect(mocks.startTour).toHaveBeenCalledOnce();
  });

  it("never starts in a read-only editor", () => {
    const { rerender } = renderHook((options) => useProductTourOnce(options), {
      initialProps: props({ readOnly: true }),
    });
    rerender(props({ readOnly: true }));
    expect(mocks.startTour).not.toHaveBeenCalled();
  });

  it("never starts over a failed load", () => {
    const { rerender } = renderHook((options) => useProductTourOnce(options), {
      initialProps: props({ loadError: "x" }),
    });
    rerender(props({ loadError: "x" }));
    expect(mocks.startTour).not.toHaveBeenCalled();
  });
});

describe("useAuthorInteractionFlag", () => {
  it("sets the flag on a key press", () => {
    const { result } = renderHook(() => useAuthorInteractionFlag());
    expect(result.current.current).toBe(false);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(result.current.current).toBe(true);
  });

  it("sets the flag on a pointer press", () => {
    const { result } = renderHook(() => useAuthorInteractionFlag());

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(result.current.current).toBe(true);
  });

  it("stops listening once unmounted", () => {
    const first = renderHook(() => useAuthorInteractionFlag());
    first.unmount();

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(first.result.current.current).toBe(false);

    const second = renderHook(() => useAuthorInteractionFlag());
    expect(second.result.current.current).toBe(false);
  });
});
