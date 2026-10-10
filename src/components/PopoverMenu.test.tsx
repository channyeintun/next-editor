import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import PopoverMenu from "./PopoverMenu";

function MenuWithTrigger() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        Options
      </button>
      <PopoverMenu
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        className="menu-card"
      >
        <button type="button" role="menuitem" onClick={() => setOpen(false)}>
          Rename
        </button>
      </PopoverMenu>
      <button type="button">Elsewhere</button>
    </>
  );
}

function openMenu() {
  render(<MenuWithTrigger />);
  const trigger = screen.getByRole("button", { name: "Options" });
  fireEvent.click(trigger);
  return trigger;
}

describe("PopoverMenu", () => {
  it("renders nothing while closed", () => {
    render(<MenuWithTrigger />);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Close menu")).not.toBeInTheDocument();
  });

  it("renders its items in a role=menu card with the given classes", () => {
    openMenu();

    const menu = screen.getByRole("menu");
    expect(menu).toHaveClass("menu-card");
    expect(screen.getByRole("menuitem", { name: "Rename" }).parentElement).toBe(menu);
  });

  it("keeps the click-outside backdrop out of the tab order and the accessibility tree", () => {
    openMenu();

    expect(screen.queryByRole("button", { name: "Close menu" })).not.toBeInTheDocument();
    const backdrop = screen.getByLabelText("Close menu");
    expect(backdrop).toHaveAttribute("tabindex", "-1");
    expect(backdrop).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(backdrop);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const trigger = openMenu();
    screen.getByRole("button", { name: "Elsewhere" }).focus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("ignores Escape once closed", () => {
    const trigger = openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(elsewhere).toHaveFocus();
    expect(trigger).not.toHaveFocus();
  });
});
