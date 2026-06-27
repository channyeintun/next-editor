import { useCallback, useEffect, useRef } from "react";
import { useSelector } from "@xstate/store-react";
import { useApiClientStoreInstance } from "../../contexts/ApiClientStoreContext";
import {
  API_CLIENT_REQUEST_MESSAGE_TYPE,
  type ApiClientResultPayload,
} from "../../utils/apiClientBridge";
import {
  selectBody,
  selectHeaders,
  selectMethod,
  selectPath,
  selectSending,
  type ApiClientResult,
} from "../../stores/apiClientStore";

const REQUEST_TIMEOUT_MS = 30_000;

let nextRequestId = 0;
function generateRequestId(): string {
  return `api-req-${++nextRequestId}-${Date.now()}`;
}

interface UseApiClientOptions {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  runtimePreviewUrl: string | null;
}

export function useApiClient({ iframeRef, runtimePreviewUrl }: UseApiClientOptions) {
  const store = useApiClientStoreInstance();
  const method = useSelector(store, (s) => selectMethod(s.context));
  const path = useSelector(store, (s) => selectPath(s.context));
  const headers = useSelector(store, (s) => selectHeaders(s.context));
  const body = useSelector(store, (s) => selectBody(s.context));
  const sending = useSelector(store, (s) => selectSending(s.context));

  const pendingIdRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPending = useCallback(() => {
    pendingIdRef.current = null;
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearPending();
  }, [clearPending]);

  const handleResponse = useCallback(
    (payload: ApiClientResultPayload) => {
      if (payload.id !== pendingIdRef.current) {
        return;
      }

      clearPending();

      const result: ApiClientResult = payload.ok
        ? {
            ok: true,
            response: {
              status: payload.status,
              statusText: payload.statusText,
              headers: payload.headers,
              body: payload.body,
              durationMs: payload.durationMs,
            },
          }
        : {
            ok: false,
            error: { error: payload.error, durationMs: payload.durationMs },
          };

      store.trigger.receiveResult({ id: payload.id, result });
    },
    [clearPending, store],
  );

  const send = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow || !runtimePreviewUrl || sending) {
      return;
    }

    const id = generateRequestId();
    const headerRecord: Record<string, string> = {};
    for (const h of headers) {
      if (h.enabled && h.key.trim()) {
        headerRecord[h.key.trim()] = h.value;
      }
    }

    const requestBody = method === "GET" ? undefined : body || undefined;

    pendingIdRef.current = id;
    store.trigger.markSending();

    let origin: string;
    try {
      origin = new URL(runtimePreviewUrl).origin;
    } catch {
      origin = "*";
    }

    iframe.contentWindow.postMessage(
      {
        type: API_CLIENT_REQUEST_MESSAGE_TYPE,
        payload: { id, method, path, headers: headerRecord, body: requestBody },
      },
      origin,
    );

    timeoutRef.current = setTimeout(() => {
      if (pendingIdRef.current !== id) {
        return;
      }

      clearPending();
      store.trigger.receiveResult({
        id,
        result: {
          ok: false,
          error: { error: "Request timed out", durationMs: REQUEST_TIMEOUT_MS },
        },
      });
    }, REQUEST_TIMEOUT_MS);
  }, [body, clearPending, headers, iframeRef, method, path, runtimePreviewUrl, sending, store]);

  return { send, handleResponse, sending };
}
