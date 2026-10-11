import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import PlayerShortcutsHelp from "./PlayerShortcutsHelp";

describe("PlayerShortcutsHelp", () => {
  it("tells keyboard users how to leave the code editor", () => {
    render(<PlayerShortcutsHelp onClose={vi.fn<() => void>()} />);

    const help = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(
      within(help).getByText(
        "In the code editor, Tab types a tab. Press Esc, then Tab, to move on.",
      ),
    ).toBeInTheDocument();
  });

  it("closes on Escape, but not on one that ends an input method's composition", () => {
    const onClose = vi.fn<() => void>();
    render(<PlayerShortcutsHelp onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    fireEvent.keyDown(window, { key: "Escape", keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
