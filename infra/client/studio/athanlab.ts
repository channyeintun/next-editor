import axios from "axios";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiClient } from "../apiClient";

/**
 * Bring-your-own-key AthanLab narration (Burmese Studio TTS). AthanLab's API
 * terms forbid using a key from a browser, so the key crosses the wire exactly
 * once — on save — and the Worker keeps it encrypted from then on: these
 * endpoints only ever answer with a display hint, never the key itself.
 */

/** What the Worker knows about the user's saved key. `hint` is "…" + its last four characters. */
export type AthanLabKeyStatus =
  | { connected: true; hint: string; updatedAt: number; invalid?: undefined; stale?: undefined }
  /** No key saved. */
  | { connected: false; invalid?: undefined; stale?: undefined }
  /** AthanLab answered 401 for the saved key; the Worker no longer sends it. */
  | { connected: false; invalid: true; hint: string; updatedAt: number; stale?: undefined }
  /** The saved key can no longer be decrypted (the server secret changed). */
  | { connected: false; stale: true; invalid?: undefined };

export interface AthanLabVoice {
  id: string;
  name: string;
  category: string;
  /** `athanlab` for official voices, `user` for voices in the user's own library. */
  source: "athanlab" | "user";
  isDefault: boolean;
}

export interface AthanLabVoiceList {
  voices: AthanLabVoice[];
  /** Null while AthanLab's default voice is unavailable (or not in the list). */
  defaultVoiceId: string | null;
}

/** Balance as `GET /usage` reports it; every number is null when AthanLab sent none. */
export interface AthanLabUsageReport {
  available?: true;
  spendable: number | null;
  /** False when the account's plan cannot create jobs (AthanLab requires Max). */
  entitled: boolean | null;
  /** Only ever an https://athanlab.com URL — the Worker drops anything else. */
  upgradeUrl: string | null;
  monthly: {
    limit: number | null;
    used: number | null;
    remaining: number | null;
    resetsAt: string | null;
  };
  tokens: { balance: number | null };
  key: { monthlyCharBudget: number | null; remaining: number | null };
}

/** `available: false` when the key lacks the optional usage:read permission. */
export type AthanLabUsage = AthanLabUsageReport | { available: false };

export interface AthanLabKeySaveResult {
  connected: true;
  hint: string;
  updatedAt: number;
  /** AthanLab's free dry-run quote for a one-word job, taken while verifying the key. */
  quote: { spendable: number | null; sufficient: boolean | null };
}

export interface AthanLabError {
  message: string;
  code: string | null;
}

/**
 * The only error these requests throw. It carries the status and the Worker's
 * `{error, code}` and nothing else: an axios error keeps the request config —
 * on save, a JSON body holding the API key — so it is never kept in Query state.
 */
class AthanLabRequestError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(message: string, status: number | null, code: string | null) {
    super(message);
    this.name = "AthanLabRequestError";
    this.status = status;
    this.code = code;
  }
}

function requestErrorOf(error: unknown): AthanLabRequestError {
  if (!axios.isAxiosError(error)) {
    return new AthanLabRequestError("Something went wrong talking to Next Editor", null, null);
  }
  const response = error.response;
  if (!response) {
    return new AthanLabRequestError(
      "Could not reach Next Editor — check your connection",
      null,
      null,
    );
  }
  const data: unknown = response.data;
  const body = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const message =
    typeof body.error === "string" && body.error.trim()
      ? body.error
      : `Request failed (HTTP ${response.status})`;
  const code = typeof body.code === "string" ? body.code : null;
  return new AthanLabRequestError(message, response.status, code);
}

async function request<T>(send: () => Promise<{ data: T }>): Promise<T> {
  try {
    return (await send()).data;
  } catch (error) {
    throw requestErrorOf(error);
  }
}

/** `{message, code}` of an error these hooks reported, safe to show. */
export function athanLabErrorOf(error: unknown): AthanLabError {
  const requestError = error instanceof AthanLabRequestError ? error : requestErrorOf(error);
  return { message: requestError.message, code: requestError.code };
}

/** A 5xx may be a cold or briefly paused Worker; a 4xx answer never changes on its own. */
function retryServerErrorOnce(failureCount: number, error: unknown): boolean {
  const status = error instanceof AthanLabRequestError ? error.status : null;
  return status !== null && status >= 500 && failureCount < 1;
}

/**
 * Same-origin URL of a voice's free sample. The Worker streams the audio itself:
 * the app is cross-origin isolated (COEP require-corp), so AthanLab's signed
 * sample URL could not play in an `<audio>` element directly.
 */
export function athanLabVoiceSampleUrl(voiceId: string): string {
  return `/api/studio/athanlab/voices/${encodeURIComponent(voiceId)}/sample`;
}

const athanLabQueryKey = (what: "key" | "voices" | "usage", userId: string | null) =>
  ["studio", "athanlab", what, userId] as const;

export function useAthanLabKey(userId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: athanLabQueryKey("key", userId),
    queryFn: () => request(() => apiClient.get<AthanLabKeyStatus>("/studio/athanlab/key")),
    enabled: enabled && userId !== null,
    retry: retryServerErrorOnce,
  });
}

export function useAthanLabVoices(userId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: athanLabQueryKey("voices", userId),
    queryFn: () => request(() => apiClient.get<AthanLabVoiceList>("/studio/athanlab/voices")),
    enabled: enabled && userId !== null,
    staleTime: 5 * 60_000,
    retry: retryServerErrorOnce,
  });
}

export function useAthanLabUsage(userId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: athanLabQueryKey("usage", userId),
    queryFn: () => request(() => apiClient.get<AthanLabUsage>("/studio/athanlab/usage")),
    enabled: enabled && userId !== null,
    staleTime: 30_000,
    // The usual reason to leave this tab is topping up or upgrading on
    // athanlab.com; coming back re-reads the balance (once it is 30 s old)
    // instead of keeping Start render blocked on the old one.
    refetchOnWindowFocus: true,
    retry: retryServerErrorOnce,
  });
}

function invalidateVoicesAndUsage(queryClient: QueryClient, userId: string | null) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: athanLabQueryKey("voices", userId) }),
    queryClient.invalidateQueries({ queryKey: athanLabQueryKey("usage", userId) }),
  ]);
}

/**
 * Saves (verifies, encrypts, stores) a key. `gcTime: 0` drops the settled
 * mutation — and the key in its variables — as soon as the caller resets it or
 * unmounts, instead of keeping it in the mutation cache for the session.
 */
export function useSaveAthanLabKey(userId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string) =>
      request(() => apiClient.put<AthanLabKeySaveResult>("/studio/athanlab/key", { apiKey })),
    gcTime: 0,
    onSuccess: (result) => {
      const status: AthanLabKeyStatus = {
        connected: true,
        hint: result.hint,
        updatedAt: result.updatedAt,
      };
      queryClient.setQueryData(athanLabQueryKey("key", userId), status);
      return invalidateVoicesAndUsage(queryClient, userId);
    },
  });
}

export function useRemoveAthanLabKey(userId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => request(() => apiClient.delete<{ connected: false }>("/studio/athanlab/key")),
    onSuccess: () => {
      const status: AthanLabKeyStatus = { connected: false };
      queryClient.setQueryData(athanLabQueryKey("key", userId), status);
      return invalidateVoicesAndUsage(queryClient, userId);
    },
  });
}

/**
 * Re-read the key status and the balance — after a render (it spent
 * characters) or once a render reported the saved key invalid or unreadable,
 * which flips the AthanLab panel back to its connect form. The voice list is
 * only marked stale: it does not change with a render, and every refetch counts
 * toward the per-user AthanLab request budget.
 */
export function invalidateAthanLabAccount(queryClient: QueryClient, userId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: athanLabQueryKey("key", userId) }),
    queryClient.invalidateQueries({ queryKey: athanLabQueryKey("usage", userId) }),
    queryClient.invalidateQueries({
      queryKey: athanLabQueryKey("voices", userId),
      refetchType: "none",
    }),
  ]);
}
