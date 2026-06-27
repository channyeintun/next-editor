import { useCallback, useEffect, useRef } from "react";
import { useApiClientStoreInstance } from "../../contexts/ApiClientStoreContext";
import {
  API_CLIENT_REQUEST_MESSAGE_TYPE,
  type ApiClientResultPayload,
} from "../../utils/apiClientBridge";
import type { ApiClientRecordedRequest, ApiClientRecordedResult } from "../../types/slides";
import { buildHeaderRecord, recordedResultToStoreResult } from "../../stores/apiClientStore";

const REQUEST_TIMEOUT_MS = 30_000;

let nextRequestId = 0;
function generateRequestId(): string {
  return `api-req-${++nextRequestId}-${Date.now()}`;
}

interface UseApiClientOptions {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  runtimePreviewUrl: string | null;
  onRequestSent?: (request: ApiClientRecordedRequest) => void;
  onResponseReceived?: (result: ApiClientRecordedResult) => void;
}

/**
 * Drives the API client transport: posts a request into the runtime preview
 * iframe (same-origin, so no CORS) and resolves the matching response from the
 * message bridge. The draft request is read from the store snapshot at send
 * time rather than via selectors, so this hook subscribes to nothing — keeping
 * `usePreviewController` from re-rendering on every keystroke in the panel.
 */
export function useApiClient({
  iframeRef,
  runtimePreviewUrl,
  onRequestSent,
  onResponseReceived,
}: UseApiClientOptions) {
  const store = useApiClientStoreInstance();

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

      // `payload` is the recorded (flat) result shape plus an `id`; reuse it for
      // both the live store update and the recording callback.
      const recordedResult: ApiClientRecordedResult = payload.ok
        ? {
            ok: true,
            status: payload.status,
            statusText: payload.statusText,
            headers: payload.headers,
            body: payload.body,
            durationMs: payload.durationMs,
          }
        : { ok: false, error: payload.error, durationMs: payload.durationMs };

      store.trigger.receiveResult({
        id: payload.id,
        result: recordedResultToStoreResult(recordedResult),
      });
      onResponseReceived?.(recordedResult);
    },
    [clearPending, onResponseReceived, store],
  );

  const send = useCallback(() => {
    const iframe = iframeRef.current;
    const { method, path, headers, body, sending } = store.getSnapshot().context;

    if (!iframe?.contentWindow || !runtimePreviewUrl || sending) {
      return;
    }

    const id = generateRequestId();
    const headerRecord = buildHeaderRecord(headers);

    const requestBody = method === "GET" ? undefined : body || undefined;

    pendingIdRef.current = id;
    store.trigger.markSending();
    onRequestSent?.({ method, path, headers: headerRecord, body: requestBody });

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
      // Record the timeout too, so replay doesn't show a request stuck "sending".
      onResponseReceived?.({
        ok: false,
        error: "Request timed out",
        durationMs: REQUEST_TIMEOUT_MS,
      });
    }, REQUEST_TIMEOUT_MS);
  }, [clearPending, iframeRef, onRequestSent, onResponseReceived, runtimePreviewUrl, store]);

  return { send, handleResponse };
}
