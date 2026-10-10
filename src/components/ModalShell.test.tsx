import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import ModalShell from "./ModalShell";

function renderShell(maxWidthClassName: "max-w-md" | "max-w-xl" = "max-w-md", modal?: boolean) {
  const onDismiss = vi.fn<() => void>();
  const view = render(
    <ModalShell
      maxWidthClassName={maxWidthClassName}
      labelledBy="shell-title"
      modal={modal}
      onDismiss={onDismiss}
    >
      <h2 id="shell-title">Title</h2>
      <button type="button">Inside</button>
      <button type="button">Last</button>
    </ModalShell>,
  );
  const card = screen.getByRole("button", { name: "Inside" }).parentElement!;
  return { ...view, onDismiss, card, backdrop: card.parentElement! };
}

/** Opens the shell from a button that stays on the page, as the editor's dialogs are opened. */
function ShellWithOpener({ withReturnTarget = false }: { withReturnTarget?: boolean }) {
  const [open, setOpen] = useState(false);
  const returnTargetRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button ref={returnTargetRef} type="button">
        Settings
      </button>
      {open ? (
        <ModalShell
          maxWidthClassName="max-w-md"
          labelledBy="shell-title"
          onDismiss={() => setOpen(false)}
          returnFocusTo={withReturnTarget ? returnTargetRef : undefined}
        >
          <h2 id="shell-title">Title</h2>
          <button type="button">Inside</button>
        </ModalShell>
      ) : null}
    </>
  );
}

describe("ModalShell", () => {
  it("draws the backdrop and a card of the requested width around its children", () => {
    const { container, backdrop, card } = renderShell("max-w-xl");

    expect(container.firstElementChild).toBe(backdrop);
    expect(backdrop.className).toBe(
      "fixed inset-0 z-50 bg-[#0b0d12]/62 px-4 py-8 backdrop-blur-[2px]",
    );
    expect(card.className).toBe(
      "mx-auto flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)] outline-none",
    );
    expect(backdrop.children).toHaveLength(1);
  });

  it("is a modal dialog named by its title", () => {
    const { card } = renderShell();

    expect(screen.getByRole("dialog", { name: "Title" })).toBe(card);
    expect(card).toHaveAttribute("aria-modal", "true");
  });

  it("reports a click on the backdrop", () => {
    const { backdrop, onDismiss } = renderShell();

    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps a drag that starts in the card and ends on the backdrop from dismissing", () => {
    const { backdrop, onDismiss } = renderShell();

    fireEvent.mouseDown(screen.getByRole("button", { name: "Inside" }));
    fireEvent.click(backdrop);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps clicks inside the card from reaching the backdrop", () => {
    const { card, onDismiss } = renderShell();

    fireEvent.click(card);
    fireEvent.click(screen.getByRole("button", { name: "Inside" }));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("focuses the first control on open", () => {
    renderShell();

    expect(screen.getByRole("button", { name: "Inside" })).toHaveFocus();
  });

  it("reports Escape pressed inside the dialog", () => {
    const { onDismiss } = renderShell();

    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), { key: "Escape" });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab from the last control back to the first", () => {
    renderShell();
    const last = screen.getByRole("button", { name: "Last" });

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });

    expect(screen.getByRole("button", { name: "Inside" })).toHaveFocus();
  });

  it("gives focus back to the button that opened it", () => {
    render(<ShellWithOpener />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("button", { name: "Inside" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("gives focus to returnFocusTo instead, when the caller names one", () => {
    render(<ShellWithOpener withReturnTarget />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), { key: "Escape" });

    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
  });

  it("when not modal, is not announced as modal, takes no focus and ignores Escape", () => {
    const { card, onDismiss } = renderShell("max-w-md", false);

    expect(screen.getByRole("dialog", { name: "Title" })).toBe(card);
    expect(card).not.toHaveAttribute("aria-modal");
    expect(card).not.toHaveAttribute("tabindex");
    expect(document.body).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), { key: "Escape" });

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
