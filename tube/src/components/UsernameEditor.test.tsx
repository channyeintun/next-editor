import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@next-editor/infra", () => ({
  useUpdateUsername: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
}));

const { default: UsernameEditor } = await import("./UsernameEditor");

function openEditor() {
  render(
    <MemoryRouter>
      <UsernameEditor username="chan" />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit username" }));
}

describe("UsernameEditor", () => {
  it("names the username field and marks it for autofill", () => {
    openEditor();

    const input = screen.getByRole("textbox", { name: "Username" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("autocomplete", "username");
    expect(input).toHaveAttribute("spellcheck", "false");
  });

  it("hides the decorative @ prefix from assistive technology", () => {
    openEditor();

    expect(screen.getByText("@")).toHaveAttribute("aria-hidden", "true");
  });
});
