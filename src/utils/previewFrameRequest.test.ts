import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { requestFromPreviewFrame } from "./previewFrameRequest";

const REQUEST_TYPE = "TEST_REQUEST";
const RESPONSE_TYPE = "TEST_RESPONSE";
const MESSAGES = {
  unavailable: "No frame",
  invalid: "Bad reply",
  timedOut: "Timed out after 50ms",
  cancelled: "Cancelled",
};

function mountFrame(): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  return iframe;
}

/** Starts a request and returns it with the id the frame was sent. */
function startRequest(iframe: HTMLIFrameElement, signal?: AbortSignal) {
  const frameWindow = iframe.contentWindow as Window;
  const postMessage = vi.spyOn(frameWindow, "postMessage").mockImplementation(() => {});
  const request = requestFromPreviewFrame({
    iframe,
    requestType: REQUEST_TYPE,
    responseType: RESPONSE_TYPE,
    idPrefix: "test",
    payload: { command: "ping" },
    timeoutMs: 50,
    signal,
    parse: (payload) => (typeof payload.value === "number" ? payload.value : undefined),
    messages: MESSAGES,
  });
  const [message, targetOrigin] = postMessage.mock.calls[0] as [
    { type: string; payload: { id: string; command: string } },
    string,
  ];
  return { request, message, targetOrigin, frameWindow };
}

function reply(source: MessageEventSource | null, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { source, data }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("requestFromPreviewFrame", () => {
  it("posts the request with a correlation id and resolves on the frame's matching reply", async () => {
    const iframe = mountFrame();
    const { request, message, targetOrigin, frameWindow } = startRequest(iframe);

    expect(targetOrigin).toBe("*");
    expect(message.type).toBe(REQUEST_TYPE);
    expect(message.payload).toEqual({ id: expect.stringMatching(/^test-\d+$/), command: "ping" });

    reply(frameWindow, { type: RESPONSE_TYPE, payload: { id: message.payload.id, value: 7 } });

    await expect(request).resolves.toBe(7);
  });

  it("ignores replies from another window, of another type or for another id", async () => {
    vi.useFakeTimers();
    const iframe = mountFrame();
    const other = mountFrame();
    const { request, message, frameWindow } = startRequest(iframe);
    const { id } = message.payload;
    const settled = vi.fn<() => void>();
    request.then(settled, settled);

    reply(other.contentWindow, { type: RESPONSE_TYPE, payload: { id, value: 1 } });
    reply(frameWindow, { type: "OTHER", payload: { id, value: 2 } });
    reply(frameWindow, { type: RESPONSE_TYPE, payload: { id: `${id}-stale`, value: 3 } });
    reply(frameWindow, { type: RESPONSE_TYPE, payload: "not an object" });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    reply(frameWindow, { type: RESPONSE_TYPE, payload: { id, value: 4 } });
    await expect(request).resolves.toBe(4);
  });

  it("rejects with the timeout message and stops listening", async () => {
    vi.useFakeTimers();
    const removeListener = vi.spyOn(window, "removeEventListener");
    const iframe = mountFrame();
    const { request } = startRequest(iframe);

    // Rejects inside the timer; the assertion below attaches before any microtask runs.
    vi.advanceTimersByTime(50);

    await expect(request).rejects.toThrow("Timed out after 50ms");
    expect(removeListener).toHaveBeenCalledWith("message", expect.any(Function));
  });

  it("rejects when aborted, or at once when the signal already was", async () => {
    const iframe = mountFrame();
    const controller = new AbortController();
    const { request } = startRequest(iframe, controller.signal);

    controller.abort();
    await expect(request).rejects.toThrow("Cancelled");

    await expect(
      requestFromPreviewFrame({
        iframe,
        requestType: REQUEST_TYPE,
        responseType: RESPONSE_TYPE,
        idPrefix: "test",
        timeoutMs: 50,
        signal: controller.signal,
        parse: () => 1,
        messages: MESSAGES,
      }),
    ).rejects.toThrow("Cancelled");
  });

  it("rejects with the frame's error string, or the invalid message for a malformed reply", async () => {
    const iframe = mountFrame();
    const failing = startRequest(iframe);
    reply(failing.frameWindow, {
      type: RESPONSE_TYPE,
      payload: { id: failing.message.payload.id, error: "Target not found" },
    });
    await expect(failing.request).rejects.toThrow("Target not found");

    vi.restoreAllMocks();
    const malformed = startRequest(iframe);
    reply(malformed.frameWindow, {
      type: RESPONSE_TYPE,
      payload: { id: malformed.message.payload.id, value: "seven" },
    });
    await expect(malformed.request).rejects.toThrow("Bad reply");
  });

  it("rejects when the iframe has no window", async () => {
    await expect(
      requestFromPreviewFrame({
        iframe: null,
        requestType: REQUEST_TYPE,
        responseType: RESPONSE_TYPE,
        idPrefix: "test",
        timeoutMs: 50,
        parse: () => 1,
        messages: MESSAGES,
      }),
    ).rejects.toThrow("No frame");
  });
});
