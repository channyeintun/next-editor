import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AuthUser } from "../../db/types";

const post = vi.hoisted(() => vi.fn<(url: string, body?: unknown) => Promise<unknown>>());

vi.mock("../apiClient", () => ({ apiClient: { post } }));
vi.mock("./googleIdentity", () => ({ disableGoogleAutoSelect: vi.fn<() => void>() }));
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn<() => Promise<unknown>>().mockResolvedValue({ id: "assertion" }),
  startRegistration: vi.fn<() => Promise<unknown>>(),
  WebAuthnError: class extends Error {},
}));

const { ME_QUERY_KEY, PASSKEY_LIST_QUERY_KEY, useGoogleCredentialSignIn, useSignOut } =
  await import("./useAuth");
const { useSignInWithPasskey } = await import("./usePasskey");

function user(id: string): AuthUser {
  return { id, email: `${id}@example.com`, name: id, avatarUrl: null, username: id };
}

// The account's own caches (keys with no user id in them), and public ones.
const OWNER_KEYS: QueryKey[] = [
  ["lessons", "mine"],
  ["playlists", "mine"],
  ["playlists", "mine", "for-lesson", "l1"],
  ["playlists", "members", "p1"],
  PASSKEY_LIST_QUERY_KEY,
];
const PUBLIC_KEYS: QueryKey[] = [
  ["lessons", "infinite"],
  ["lessons", "detail", "ownership"],
  ["playlists", "detail", "intro"],
];

function signedInAs(account: AuthUser): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(ME_QUERY_KEY, account);
  for (const key of [...OWNER_KEYS, ...PUBLIC_KEYS]) {
    queryClient.setQueryData(key, [`cached for ${account.id}`]);
  }
  return queryClient;
}

function cached(queryClient: QueryClient, keys: QueryKey[]) {
  return keys.filter((key) => queryClient.getQueryData(key) !== undefined);
}

function renderAuthHook<T>(queryClient: QueryClient, hook: () => T) {
  return renderHook(hook, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

// The passkey ceremony posts for options first, then verifies and gets the user.
function passkeyServerSignsIn(account: AuthUser) {
  post.mockImplementation(async (url) =>
    url === "/auth/passkey/login/verify" ? { data: { user: account } } : { data: {} },
  );
}

beforeEach(() => {
  post.mockReset();
});

describe("signing out", () => {
  it("drops the account's own caches and keeps the public ones", async () => {
    const queryClient = signedInAs(user("a"));
    post.mockResolvedValue({ data: {} });
    const { result } = renderAuthHook(queryClient, () => useSignOut());

    await act(() => result.current.mutateAsync());

    expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeNull();
    expect(cached(queryClient, OWNER_KEYS)).toEqual([]);
    expect(cached(queryClient, PUBLIC_KEYS)).toEqual(PUBLIC_KEYS);
  });
});

describe("signing in without a reload", () => {
  it("drops the last account's caches when a passkey signs in someone else", async () => {
    const queryClient = signedInAs(user("a"));
    passkeyServerSignsIn(user("b"));
    const { result } = renderAuthHook(queryClient, () => useSignInWithPasskey());

    await act(() => result.current.mutateAsync());

    expect(queryClient.getQueryData(ME_QUERY_KEY)).toEqual(user("b"));
    expect(cached(queryClient, OWNER_KEYS)).toEqual([]);
    expect(cached(queryClient, PUBLIC_KEYS)).toEqual(PUBLIC_KEYS);
  });

  it("keeps the caches when a passkey signs the same account back in", async () => {
    const queryClient = signedInAs(user("a"));
    passkeyServerSignsIn(user("a"));
    const { result } = renderAuthHook(queryClient, () => useSignInWithPasskey());

    await act(() => result.current.mutateAsync());

    expect(cached(queryClient, OWNER_KEYS)).toEqual(OWNER_KEYS);
  });

  it("drops the last account's caches when One Tap signs in someone else", async () => {
    const queryClient = signedInAs(user("a"));
    post.mockResolvedValue({ data: { user: user("b") } });
    const { result } = renderAuthHook(queryClient, () => useGoogleCredentialSignIn());

    await act(() => result.current.mutateAsync("credential"));

    expect(queryClient.getQueryData(ME_QUERY_KEY)).toEqual(user("b"));
    expect(cached(queryClient, OWNER_KEYS)).toEqual([]);
  });

  it("keeps the caches when One Tap signs the same account back in", async () => {
    const queryClient = signedInAs(user("a"));
    post.mockResolvedValue({ data: { user: user("a") } });
    const { result } = renderAuthHook(queryClient, () => useGoogleCredentialSignIn());

    await act(() => result.current.mutateAsync("credential"));

    expect(cached(queryClient, OWNER_KEYS)).toEqual(OWNER_KEYS);
  });
});
