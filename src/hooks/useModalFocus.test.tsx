import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { useModalFocus } from "./useModalFocus";

function Card({
  active,
  onEscape,
  returnFocusTo,
  children,
}: {
  active: boolean;
  onEscape: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useModalFocus(cardRef, { active, onEscape, returnFocusTo });
  return (
    <div ref={cardRef} tabIndex={-1} data-testid="card" onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

/** An opener that shows the card, the way the editor's settings buttons do. */
function Harness({
  active = true,
  onEscape = () => {},
  useReturnTarget = false,
  children = (
    <>
      <button type="button">First</button>
      <button type="button">Last</button>
    </>
  ),
}: {
  active?: boolean;
  onEscape?: () => void;
  useReturnTarget?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const returnTargetRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Close from outside
      </button>
      <button ref={returnTargetRef} type="button">
        Return target
      </button>
      {open ? (
        <Card
          active={active}
          onEscape={onEscape}
          returnFocusTo={useReturnTarget ? returnTargetRef : undefined}
        >
          {children}
        </Card>
      ) : null}
    </>
  );
}

function openCard(props: Parameters<typeof Harness>[0] = {}) {
  const view = render(<Harness {...props} />);
  const opener = screen.getByRole("button", { name: "Open" });
  opener.focus();
  fireEvent.click(opener);
  return {
    ...view,
    opener,
    close: () => fireEvent.click(screen.getByRole("button", { name: "Close from outside" })),
  };
}

const button = (name: string) => screen.getByRole("button", { name });

describe("useModalFocus", () => {
  it("moves focus to the first control on open", () => {
    openCard();

    expect(button("First")).toHaveFocus();
  });

  it("focuses the card itself when nothing in it takes focus", () => {
    openCard({ children: <p>Only text</p> });

    expect(screen.getByTestId("card")).toHaveFocus();
  });

  it("leaves focus on an autoFocus child, and still returns it to the opener", () => {
    const { opener, close } = openCard({
      children: (
        <>
          <button type="button">First</button>
          <input aria-label="Name" autoFocus />
        </>
      ),
    });

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();

    close();

    expect(opener).toHaveFocus();
  });

  it("calls onEscape for Escape and keeps it from reaching the document", () => {
    const onEscape = vi.fn<() => void>();
    const keysReachingDocument: string[] = [];
    const onDocumentKeyDown = (event: KeyboardEvent) => keysReachingDocument.push(event.key);
    document.addEventListener("keydown", onDocumentKeyDown);
    openCard({ onEscape });

    fireEvent.keyDown(button("First"), { key: "Enter" });
    expect(onEscape).not.toHaveBeenCalled();

    fireEvent.keyDown(button("First"), { key: "Escape" });
    document.removeEventListener("keydown", onDocumentKeyDown);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(keysReachingDocument).toEqual(["Enter"]);
  });

  it("leaves an Escape that ends an IME composition alone", () => {
    const onEscape = vi.fn<() => void>();
    openCard({ onEscape });

    fireEvent.keyDown(button("First"), { key: "Escape", isComposing: true });
    // Safari's key that ends a composition comes after compositionend.
    fireEvent.keyDown(button("First"), { key: "Escape", keyCode: 229 });

    expect(onEscape).not.toHaveBeenCalled();
  });

  it("wraps Tab from the last control to the first, and Shift+Tab back", () => {
    openCard();

    button("Last").focus();
    expect(fireEvent.keyDown(button("Last"), { key: "Tab" })).toBe(false);
    expect(button("First")).toHaveFocus();

    expect(fireEvent.keyDown(button("First"), { key: "Tab", shiftKey: true })).toBe(false);
    expect(button("Last")).toHaveFocus();

    // Inside the card, Tab is the browser's own.
    expect(fireEvent.keyDown(button("Last"), { key: "Tab", shiftKey: true })).toBe(true);
    expect(button("Last")).toHaveFocus();
  });

  it("treats a radio group as one Tab stop, the way the browser does", () => {
    openCard({
      children: (
        <>
          <button type="button">First</button>
          <input type="radio" name="where" aria-label="Memory" />
          <input type="radio" name="where" aria-label="Tab" defaultChecked />
          <input type="radio" name="where" aria-label="Device" />
        </>
      ),
    });
    const checked = screen.getByRole("radio", { name: "Tab" });

    checked.focus();
    expect(fireEvent.keyDown(checked, { key: "Tab" })).toBe(false);
    expect(button("First")).toHaveFocus();

    fireEvent.keyDown(button("First"), { key: "Tab", shiftKey: true });
    expect(checked).toHaveFocus();
  });

  it("returns focus to the element that had it when the dialog opened", () => {
    const { opener, close } = openCard();

    close();

    expect(opener).toHaveFocus();
  });

  it("returns focus to returnFocusTo ahead of the opener", () => {
    const { close } = openCard({ useReturnTarget: true });

    close();

    expect(button("Return target")).toHaveFocus();
  });

  it("does nothing while inactive", () => {
    const onEscape = vi.fn<() => void>();
    const { opener, close } = openCard({ active: false, onEscape });

    expect(opener).toHaveFocus();

    button("Last").focus();
    fireEvent.keyDown(button("Last"), { key: "Escape" });
    expect(fireEvent.keyDown(button("Last"), { key: "Tab" })).toBe(true);
    expect(onEscape).not.toHaveBeenCalled();
    expect(button("Last")).toHaveFocus();

    button("Close from outside").focus();
    close();
    expect(button("Close from outside")).toHaveFocus();
  });
});
