import axios from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { AuthUser, PasskeySummary } from "../../db/types";
import { apiClient } from "../apiClient";
import { ME_QUERY_KEY } from "./useAuth";

const PASSKEY_LIST_QUERY_KEY = ["auth", "passkeys"] as const;

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
// (InvalidStateError). A statement of fact, not a failure.
export function isPasskeyAlreadyRegistered(error: unknown): boolean {
  return (
    (error instanceof WebAuthnError &&
      error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") ||
    (error instanceof Error && error.name === "InvalidStateError")
  );
}

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
      const options = (
        await apiClient.post<PublicKeyCredentialCreationOptionsJSON>(
          "/auth/passkey/register/options",
        )
      ).data;
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
      const options = (
        await apiClient.post<PublicKeyCredentialRequestOptionsJSON>("/auth/passkey/login/options")
      ).data;
      const response = await startAuthentication({ optionsJSON: options });
      const res = await apiClient.post<{ user: AuthUser }>("/auth/passkey/login/verify", response);
      return res.data.user;
    },
    onSuccess: (user) => {
      queryClient.setQueryData(ME_QUERY_KEY, user);
    },
  });
}
