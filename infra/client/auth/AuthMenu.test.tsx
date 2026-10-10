import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./useAuth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      email: "ada@example.com",
      name: "Ada",
      avatarUrl: null,
      username: "ada",
    },
    isSignedIn: true,
    isLoading: false,
  }),
  useSignOut: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
  signInUrl: (returnTo: string) => `/auth/google?returnTo=${returnTo}`,
  avatarProxyUrl: (url: string) => url,
}));
vi.mock("./usePasskey", () => ({
  browserSupportsPasskeys: () => false,
  isPasskeyAlreadyRegistered: () => false,
  isPasskeyCancel: () => false,
  passkeyErrorMessage: (_error: unknown, fallback: string) => fallback,
  usePasskeyList: () => ({ passkeys: [] }),
  useRegisterPasskey: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
  useSignInWithPasskey: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
}));
vi.mock("./GoogleOneTap", () => ({ default: () => null }));
vi.mock("@app/utils/analytics", () => ({
  analytics: {
    identify: vi.fn<() => void>(),
    capture: vi.fn<() => void>(),
    reset: vi.fn<() => void>(),
  },
}));

const { default: AuthMenu } = await import("./AuthMenu");

function openMenu() {
  render(
    <MemoryRouter>
      <AuthMenu />
    </MemoryRouter>,
  );
  const trigger = screen.getByRole("button", { name: /Ada/ });
  fireEvent.click(trigger);
  return trigger;
}

describe("AuthMenu", () => {
  it("keeps the click-outside backdrop out of the tab order and the accessibility tree", () => {
    openMenu();

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close menu" })).not.toBeInTheDocument();
    const backdrop = screen.getByLabelText("Close menu");
    expect(backdrop).toHaveAttribute("tabindex", "-1");

    fireEvent.click(backdrop);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the avatar button", () => {
    const trigger = openMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes when a link item is chosen", () => {
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "My Library" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
