import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import ModalShell from "./ModalShell";

function renderShell(maxWidthClassName: "max-w-md" | "max-w-xl" = "max-w-md") {
  const onBackdropClick = vi.fn<() => void>();
  const view = render(
    <ModalShell maxWidthClassName={maxWidthClassName} onBackdropClick={onBackdropClick}>
      <button type="button">Inside</button>
    </ModalShell>,
  );
  const card = screen.getByRole("button", { name: "Inside" }).parentElement!;
  return { ...view, onBackdropClick, card, backdrop: card.parentElement! };
}

describe("ModalShell", () => {
  it("draws the backdrop and a card of the requested width around its children", () => {
    const { container, backdrop, card } = renderShell("max-w-xl");

    expect(container.firstElementChild).toBe(backdrop);
    expect(backdrop.className).toBe(
      "fixed inset-0 z-50 bg-[#0b0d12]/62 px-4 py-8 backdrop-blur-[2px]",
    );
    expect(card.className).toBe(
      "mx-auto flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)]",
    );
    expect(backdrop.children).toHaveLength(1);
  });

  it("reports a click on the backdrop", () => {
    const { backdrop, onBackdropClick } = renderShell();

    fireEvent.click(backdrop);

    expect(onBackdropClick).toHaveBeenCalledTimes(1);
  });

  it("keeps clicks inside the card from reaching the backdrop", () => {
    const { card, onBackdropClick } = renderShell();

    fireEvent.click(card);
    fireEvent.click(screen.getByRole("button", { name: "Inside" }));

    expect(onBackdropClick).not.toHaveBeenCalled();
  });
});
