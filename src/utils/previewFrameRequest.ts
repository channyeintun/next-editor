export interface PreviewFrameRequestMessages {
  /** The iframe has no window to post to. */
  unavailable: string;
  /** The reply matched but `parse` rejected it. */
  invalid: string;
  /** No reply arrived within `timeoutMs`. */
  timedOut: string;
  /** `signal` aborted before the reply arrived. */
  cancelled?: string;
}

export interface PreviewFrameRequestOptions<T> {
  iframe: HTMLIFrameElement | null;
  requestType: string;
  responseType: string;
  /** Correlation ids are `${idPrefix}-${n}`; the frame echoes the id back unread. */
  idPrefix: string;
  /** Request fields posted beside the correlation id. */
  payload?: Record<string, unknown>;
  timeoutMs: number;
  /** Abandons the reply: the frame is not told, so the request must be safe to finish unread. */
  signal?: AbortSignal;
  /** The result in a matching reply's payload, or undefined when the reply is malformed. */
  parse: (payload: Record<string, unknown>) => T | undefined;
  messages: PreviewFrameRequestMessages;
}

let previewFrameRequestId = 0;

/**
 * Posts one request into a preview iframe's injected bridge and settles with
 * its correlated reply. Only a reply from that iframe's own window, of the
 * response type and carrying this request's id, counts; a string `error` in it
 * rejects. Every way out — reply, timeout, abort — removes the listeners.
 */
export function requestFromPreviewFrame<T>({
  iframe,
  requestType,
  responseType,
  idPrefix,
  payload,
  timeoutMs,
  signal,
  parse,
  messages,
}: PreviewFrameRequestOptions<T>): Promise<T> {
  const targetWindow = iframe?.contentWindow;
  if (!targetWindow) {
    return Promise.reject(new Error(messages.unavailable));
  }
  const cancelled = messages.cancelled ?? "The preview request was cancelled";
  if (signal?.aborted) {
    return Promise.reject(new Error(cancelled));
  }

  previewFrameRequestId += 1;
  const id = `${idPrefix}-${previewFrameRequestId}`;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", handleMessage);
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      cleanup();
      reject(new Error(cancelled));
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== targetWindow || event.data?.type !== responseType) {
        return;
      }

      const reply: unknown = event.data.payload;
      if (typeof reply !== "object" || reply === null || (reply as { id?: unknown }).id !== id) {
        return;
      }

      cleanup();

      const replyPayload = reply as Record<string, unknown>;
      if (typeof replyPayload.error === "string") {
        reject(new Error(replyPayload.error));
        return;
      }

      const result = parse(replyPayload);
      if (result === undefined) {
        reject(new Error(messages.invalid));
        return;
      }

      resolve(result);
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error(messages.timedOut));
    }, timeoutMs);

    window.addEventListener("message", handleMessage);
    signal?.addEventListener("abort", handleAbort, { once: true });
    targetWindow.postMessage({ type: requestType, payload: { id, ...payload } }, "*");
  });
}
