import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PasskeySummary } from "../../db/types";

const api = vi.hoisted(() => ({
  get: vi.fn<(url: string) => Promise<unknown>>(),
  delete: vi.fn<(url: string) => Promise<unknown>>(),
}));

vi.mock("../apiClient", () => ({ apiClient: api }));
vi.mock("@app/utils/analytics", () => ({ analytics: { capture: vi.fn<() => void>() } }));

const { default: PasskeyListDialog } = await import("./PasskeyListDialog");

const DAY = 24 * 60 * 60 * 1000;
let stored: PasskeySummary[];

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PasskeyListDialog onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  stored = [
    { id: "cred-1", createdAt: Date.UTC(2026, 9, 1), lastUsedAt: Date.UTC(2026, 10, 10) },
    { id: "cred/2", createdAt: Date.UTC(2026, 10, 9) + DAY / 2, lastUsedAt: null },
  ];
  api.get.mockReset().mockImplementation(async () => ({ data: { passkeys: stored } }));
  api.delete.mockReset().mockImplementation(async (url) => {
    stored = stored.filter((passkey) => !url.endsWith(encodeURIComponent(passkey.id)));
    return { data: { removed: true } };
  });
});

describe("PasskeyListDialog", () => {
  // The owner can only remove a passkey they did not add if they can see it.
  it("lists every passkey with when it was added and last used", async () => {
    renderDialog();

    expect(await screen.findByText("Passkey 1")).toBeInTheDocument();
    expect(screen.getByText("Passkey 2")).toBeInTheDocument();
    expect(screen.getByText(/last used/)).toBeInTheDocument();
    expect(screen.getByText(/never used to sign in/)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith("/auth/passkey/credentials");
  });

  it("removes a passkey and shows the list without it", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Remove passkey 2" }));

    await waitFor(() => expect(screen.queryByText("Passkey 2")).not.toBeInTheDocument());
    expect(api.delete).toHaveBeenCalledWith("/auth/passkey/credentials/cred%2F2");
    expect(screen.getByText("Passkey 1")).toBeInTheDocument();
  });

  it("says why when a removal fails", async () => {
    api.delete.mockRejectedValueOnce(new Error("network"));
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Remove passkey 1" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't remove the passkey.");
    expect(screen.getByText("Passkey 1")).toBeInTheDocument();
  });
});
