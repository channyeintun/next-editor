import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import PlayerShortcutsHelp from "./PlayerShortcutsHelp";

describe("PlayerShortcutsHelp", () => {
  it("is named by its visible title", () => {
    render(<PlayerShortcutsHelp onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("moves focus to its Close button and back to the opener when it closes", () => {
    const opener = document.createElement("button");
    opener.textContent = "Opener";
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(<PlayerShortcutsHelp onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Close keyboard shortcuts" })).toHaveFocus();

    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("restores nothing when the page had no focus before it opened", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const { unmount } = render(<PlayerShortcutsHelp onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Close keyboard shortcuts" })).toHaveFocus();
    unmount();
    expect(document.body).toHaveFocus();
  });

  it("closes on Escape and from its Close button", () => {
    const onClose = vi.fn<() => void>();
    render(<PlayerShortcutsHelp onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close keyboard shortcuts" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
