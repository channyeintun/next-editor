import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { MAX_DESCRIPTION_CHARS, MAX_TITLE_CHARS } from "../../../infra/lessons/metadataLimits";

vi.mock("@next-editor/infra", async () => ({
  ...(await import("../../../infra/lessons/metadataLimits")),
  useCreatePlaylist: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
}));

const { default: CreatePlaylistModal } = await import("./CreatePlaylistModal");

/** The "New playlist" button that opens the modal, the way PlaylistsSection does. */
function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        New playlist
      </button>
      {open ? (
        <CreatePlaylistModal
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

describe("CreatePlaylistModal", () => {
  it("is a modal dialog named by its heading, with focus on the name field", () => {
    render(<CreatePlaylistModal onClose={() => {}} />);

    const dialog = screen.getByRole("dialog", { name: "New playlist" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByPlaceholderText("Playlist name")).toHaveFocus();
  });

  it("closes once on Escape and returns focus to the opener", () => {
    const onClose = vi.fn<() => void>();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "New playlist" });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.keyDown(screen.getByPlaceholderText("Playlist name"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  // Only containment is asserted: jsdom's querySelectorAll returns a selector
  // list's matches grouped by selector (buttons before inputs), not in
  // document order as browsers do, so which control is "last" differs here.
  it("keeps Shift+Tab from the first control inside the dialog", () => {
    render(<CreatePlaylistModal onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "New playlist" });
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();

    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });

    expect(close).not.toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("caps the name and description at the Worker's limits", () => {
    render(<CreatePlaylistModal onClose={() => {}} />);

    expect(screen.getByPlaceholderText<HTMLInputElement>("Playlist name").maxLength).toBe(
      MAX_TITLE_CHARS,
    );
    expect(screen.getByPlaceholderText<HTMLInputElement>("Description (optional)").maxLength).toBe(
      MAX_DESCRIPTION_CHARS,
    );
  });

  it("keeps the global focus ring on both fields", () => {
    render(<CreatePlaylistModal onClose={() => {}} />);

    expect(screen.getByPlaceholderText("Playlist name")).not.toHaveClass("outline-none");
    expect(screen.getByPlaceholderText("Description (optional)")).not.toHaveClass("outline-none");
  });

  it("announces an empty name and ties the error to the name field", () => {
    render(<CreatePlaylistModal onClose={() => {}} />);
    const input = screen.getByPlaceholderText("Playlist name");
    expect(input).not.toHaveAttribute("aria-invalid");

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Playlist name can't be empty.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Playlist name can't be empty.");
  });
});
