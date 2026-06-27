import { createStore } from "@xstate/store-react";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiClientHeader {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ApiClientResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  durationMs: number;
}

export interface ApiClientError {
  error: string;
  durationMs: number;
}

export type ApiClientResult =
  | { ok: true; response: ApiClientResponse }
  | { ok: false; error: ApiClientError };

export interface ApiClientHistoryEntry {
  id: string;
  method: HttpMethod;
  path: string;
  result: ApiClientResult;
  timestamp: number;
}

export interface ApiClientStoreContext {
  method: HttpMethod;
  path: string;
  headers: ApiClientHeader[];
  body: string;
  sending: boolean;
  result: ApiClientResult | null;
  history: ApiClientHistoryEntry[];
}

const MAX_HISTORY = 25;

function initialContext(): ApiClientStoreContext {
  return {
    method: "GET",
    path: "/",
    headers: [],
    body: "",
    sending: false,
    result: null,
    history: [],
  };
}

export function createApiClientStore() {
  return createStore({
    context: initialContext(),
    on: {
      setMethod: (context, event: { method: HttpMethod }) =>
        event.method === context.method ? context : { ...context, method: event.method },

      setPath: (context, event: { path: string }) =>
        event.path === context.path ? context : { ...context, path: event.path },

      setBody: (context, event: { body: string }) =>
        event.body === context.body ? context : { ...context, body: event.body },

      addHeader: (context) => ({
        ...context,
        headers: [...context.headers, { key: "", value: "", enabled: true }],
      }),

      updateHeader: (
        context,
        event: { index: number; key?: string; value?: string; enabled?: boolean },
      ) => {
        const headers = context.headers.map((h, i) =>
          i === event.index
            ? {
                key: event.key ?? h.key,
                value: event.value ?? h.value,
                enabled: event.enabled ?? h.enabled,
              }
            : h,
        );
        return { ...context, headers };
      },

      removeHeader: (context, event: { index: number }) => ({
        ...context,
        headers: context.headers.filter((_, i) => i !== event.index),
      }),

      markSending: (context) => ({ ...context, sending: true, result: null }),

      receiveResult: (context, event: { id: string; result: ApiClientResult }) => {
        const entry: ApiClientHistoryEntry = {
          id: event.id,
          method: context.method,
          path: context.path,
          result: event.result,
          timestamp: Date.now(),
        };
        const history = [entry, ...context.history].slice(0, MAX_HISTORY);
        return { ...context, sending: false, result: event.result, history };
      },

      selectFromHistory: (context, event: { entry: ApiClientHistoryEntry }) => ({
        ...context,
        method: event.entry.method,
        path: event.entry.path,
        result: event.entry.result,
      }),

      // Replay-only: replace the visible request/response without touching history.
      // Playback re-applies state at many timeline points, so this must be a plain
      // overwrite (unlike `receiveResult`, which appends a history entry every call).
      applyReplayState: (
        context,
        event: {
          method: HttpMethod;
          path: string;
          body: string;
          sending: boolean;
          result: ApiClientResult | null;
        },
      ) => ({
        ...context,
        method: event.method,
        path: event.path,
        body: event.body,
        sending: event.sending,
        result: event.result,
      }),

      reset: () => initialContext(),
    },
  });
}

export type ApiClientStoreInstance = ReturnType<typeof createApiClientStore>;

export const selectMethod = (c: ApiClientStoreContext): HttpMethod => c.method;
export const selectPath = (c: ApiClientStoreContext): string => c.path;
export const selectHeaders = (c: ApiClientStoreContext): ApiClientHeader[] => c.headers;
export const selectBody = (c: ApiClientStoreContext): string => c.body;
export const selectSending = (c: ApiClientStoreContext): boolean => c.sending;
export const selectResult = (c: ApiClientStoreContext): ApiClientResult | null => c.result;
export const selectHistory = (c: ApiClientStoreContext): ApiClientHistoryEntry[] => c.history;
