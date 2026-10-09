import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { PlayerShortcutFeedback } from "./PlayerShortcutsHelp";

describe("PlayerShortcutFeedback", () => {
  it("keeps one status region mounted and puts each message inside it", () => {
    const { rerender } = render(<PlayerShortcutFeedback feedback={null} />);
    // Mounted before any key is pressed, so the first message is a change inside it.
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();

    rerender(<PlayerShortcutFeedback feedback={{ text: "Muted", at: 1 }} />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Muted");

    rerender(<PlayerShortcutFeedback feedback={null} />);
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toBeEmptyDOMElement();
  });

  it("adds a new node for a repeated message, so it is announced again", () => {
    const { rerender } = render(<PlayerShortcutFeedback feedback={{ text: "+5 s", at: 1 }} />);
    const first = screen.getByRole("status").firstElementChild;
    expect(first).toHaveTextContent("+5 s");

    rerender(<PlayerShortcutFeedback feedback={{ text: "+5 s", at: 2 }} />);
    const second = screen.getByRole("status").firstElementChild;
    expect(second).toHaveTextContent("+5 s");
    expect(second).not.toBe(first);
  });

  it("hides the visible bubble from assistive technology so the message is heard once", () => {
    render(<PlayerShortcutFeedback feedback={{ text: "1.25×", at: 1 }} />);
    const copies = screen.getAllByText("1.25×");
    expect(copies).toHaveLength(2);
    const bubble = copies.find((node) => !screen.getByRole("status").contains(node));
    expect(bubble).toHaveAttribute("aria-hidden", "true");
  });
});
