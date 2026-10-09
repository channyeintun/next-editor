import { act, fireEvent, render, screen } from "@testing-library/react";
import { AxiosError, type AxiosResponse } from "axios";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type MutateOptions = { onSuccess?: () => void; onError?: (err: unknown) => void };

const mutate = vi.hoisted(() => vi.fn<(username: string, options?: MutateOptions) => void>());

vi.mock("@next-editor/infra", () => ({
  useUpdateUsername: () => ({ mutate, isPending: false }),
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

function conflict() {
  return new AxiosError("Conflict", "ERR_BAD_REQUEST", undefined, undefined, {
    status: 409,
  } as AxiosResponse);
}

describe("UsernameEditor", () => {
  beforeEach(() => {
    mutate.mockReset();
  });

  it("names the username field and marks it for autofill", () => {
    openEditor();

    const input = screen.getByRole("textbox", { name: "Username" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("autocomplete", "username");
    expect(input).toHaveAttribute("spellcheck", "false");
  });

  it("hides the decorative @ prefix from assistive technology", () => {
    openEditor();

    const prefix = screen.getByText("@");
    expect(prefix).toHaveAttribute("aria-hidden", "true");
    expect(prefix).toHaveClass("text-slate-400");
  });

  it("keeps the global focus ring on the username field", () => {
    openEditor();

    expect(screen.getByRole("textbox", { name: "Username" })).not.toHaveClass("outline-none");
  });

  it("announces a failed save and ties the error to the field", () => {
    mutate.mockImplementation((_username, options) => options?.onError?.(conflict()));
    openEditor();
    const input = screen.getByRole("textbox", { name: "Username" });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");

    fireEvent.change(input, { target: { value: "taken" } });
    const save = screen.getByRole("button", { name: "Save username" });
    act(() => save.focus());
    fireEvent.click(save);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("That username is already taken.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("That username is already taken.");
    expect(input).toHaveFocus();
  });

  it("clears the alert on retry so a repeat failure is announced again", () => {
    mutate.mockImplementation((_username, options) => options?.onError?.(conflict()));
    openEditor();
    const input = screen.getByRole("textbox", { name: "Username" });
    fireEvent.change(input, { target: { value: "taken" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    let pending: MutateOptions | undefined;
    mutate.mockImplementation((_username, options) => {
      pending = options;
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => pending?.onError?.(conflict()));
    expect(screen.getByRole("alert")).toHaveTextContent("That username is already taken.");
  });
});
