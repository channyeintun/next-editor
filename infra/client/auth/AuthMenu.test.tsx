import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  supportsPasskeys: false,
  passkeys: [] as Array<{ id: string; createdAt: number; lastUsedAt: number | null }>,
  register: vi.fn<(variables: undefined, options: { onError: (err: unknown) => void }) => void>(),
  signOutEverywhere: vi.fn<() => void>(),
}));

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
  useSignOutEverywhere: () => ({ mutate: mocks.signOutEverywhere, isPending: false }),
  signInUrl: (returnTo: string) => `/auth/google?returnTo=${returnTo}`,
  avatarProxyUrl: (url: string) => url,
}));
vi.mock("./usePasskey", () => ({
  browserSupportsPasskeys: () => mocks.supportsPasskeys,
  isPasskeyAlreadyRegistered: () => false,
  isPasskeyCancel: () => false,
  isPasskeySignInTooOld: (error: unknown) => error === "session too old",
  passkeyErrorMessage: (_error: unknown, fallback: string) => fallback,
  usePasskeyList: () => ({ passkeys: mocks.passkeys, isLoading: false }),
  useRegisterPasskey: () => ({ mutate: mocks.register, isPending: false }),
  useRemovePasskey: () => ({ mutate: vi.fn<() => void>(), isPending: false }),
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

beforeEach(() => {
  mocks.supportsPasskeys = false;
  mocks.passkeys = [];
  mocks.register.mockReset();
  mocks.signOutEverywhere.mockReset();
});

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

  it("signs out of every session from the menu", () => {
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out everywhere" }));

    expect(mocks.signOutEverywhere).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // Adding a passkey needs a recent sign-in; an older session is sent to sign
  // in again rather than told the ceremony failed.
  it("offers a fresh sign-in when the session is too old to add a passkey", () => {
    mocks.supportsPasskeys = true;
    mocks.register.mockImplementation((_variables, options) => options.onError("session too old"));
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Add a passkey" }));

    const link = screen.getByRole("menuitem", { name: "Sign in again to add a passkey" });
    expect(link).toHaveAttribute("href", expect.stringContaining("/auth/google?returnTo="));
  });

  it("opens the passkey list once the account has one", () => {
    mocks.passkeys = [{ id: "cred-1", createdAt: 0, lastUsedAt: null }];
    openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Manage passkeys" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Your passkeys" })).toBeInTheDocument();
    expect(screen.getByText("Passkey 1")).toBeInTheDocument();
  });

  it("offers no passkey list to an account without passkeys", () => {
    openMenu();

    expect(screen.queryByRole("menuitem", { name: "Manage passkeys" })).not.toBeInTheDocument();
  });
});
