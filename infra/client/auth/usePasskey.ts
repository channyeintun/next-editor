import axios from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { AuthUser, PasskeySummary } from "../../db/types";
import { apiClient } from "../apiClient";
import {
  clearOwnerScopedQueriesIfAccountChanged,
  ME_QUERY_KEY,
  PASSKEY_LIST_QUERY_KEY,
} from "./useAuth";

export function browserSupportsPasskeys(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

// The user closing/denying the platform passkey dialog surfaces as
// NotAllowedError — an everyday non-event that shouldn't be reported as a
// failure.
export function isPasskeyCancel(error: unknown): boolean {
  return error instanceof Error && error.name === "NotAllowedError";
}

// excludeCredentials doing its job: the authenticator already holds a
// passkey for this account and refuses to mint a duplicate
// (InvalidStateError). A statement of fact, not a failure. Reads the `code`
// @simplewebauthn/browser's WebAuthnError carries rather than checking the
// class, so this module never has to load the library just to classify.
export function isPasskeyAlreadyRegistered(error: unknown): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") ||
    (error instanceof Error && error.name === "InvalidStateError")
  );
}

// The WebAuthn client is only needed once someone starts a passkey ceremony,
// so it stays out of the bundle every page loads. It is fetched alongside the
// ceremony's options request, so the ceremony starts no later than it did when
// the library was bundled.
const loadWebAuthn = () => import("@simplewebauthn/browser");

// Prefers the server's {error} body (which says *why* — expired challenge,
// unknown passkey, …) over axios's generic status text.
export function passkeyErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const serverError = (error.response?.data as { error?: unknown } | undefined)?.error;
    if (typeof serverError === "string") return serverError;
  }
  return fallback;
}

/** The signed-in user's registered passkeys. Only fetched where rendered (account menu). */
export function usePasskeyList() {
  const query = useQuery({
    queryKey: PASSKEY_LIST_QUERY_KEY,
    queryFn: async () =>
      (await apiClient.get<{ passkeys: PasskeySummary[] }>("/auth/passkey/credentials")).data
        .passkeys,
    staleTime: 60_000,
  });
  return { passkeys: query.data ?? [], isLoading: query.isPending };
}

/** Adds a passkey to the signed-in account (requires a session). */
export function useRegisterPasskey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const [{ startRegistration }, { data: options }] = await Promise.all([
        loadWebAuthn(),
        apiClient.post<PublicKeyCredentialCreationOptionsJSON>("/auth/passkey/register/options"),
      ]);
      const response = await startRegistration({ optionsJSON: options });
      await apiClient.post("/auth/passkey/register/verify", response);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PASSKEY_LIST_QUERY_KEY });
    },
  });
}

/** Signs in with a discoverable passkey; on success the session cookie is set. */
export function useSignInWithPasskey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const [{ startAuthentication }, { data: options }] = await Promise.all([
        loadWebAuthn(),
        apiClient.post<PublicKeyCredentialRequestOptionsJSON>("/auth/passkey/login/options"),
      ]);
      const response = await startAuthentication({ optionsJSON: options });
      const res = await apiClient.post<{ user: AuthUser }>("/auth/passkey/login/verify", response);
      return res.data.user;
    },
    onSuccess: (user) => {
      clearOwnerScopedQueriesIfAccountChanged(queryClient, user);
      queryClient.setQueryData(ME_QUERY_KEY, user);
    },
  });
}
