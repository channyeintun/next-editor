// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createPreviewPageBridge, reloadPreview } from "./pageBridge";

const PREVIEW = "http://k3j2h1-5173.localhost:5173";

function messageEvent(data: unknown, origin: string, source: unknown): MessageEvent {
  const event = new Event("message") as MessageEvent;
  Object.defineProperties(event, {
    data: { value: data },
    origin: { value: origin },
    source: { value: source },
  });
  return event;
}

function setup() {
  const target = new EventTarget();
  const opened: [number, MessagePort][] = [];
  const forwarded: Record<string, unknown>[] = [];
  const bridge = createPreviewPageBridge(
    {
      serverPortForOrigin: (origin) => (origin === PREVIEW ? 5173 : null),
      openControlPort: (port, messagePort) => opened.push([port, messagePort]),
      onPreviewMessage: (message) => forwarded.push(message),
    },
    target,
  );
  const replies: {
    message: { type: string; port: MessagePort };
    options: WindowPostMessageOptions;
  }[] = [];
  const source = {
    postMessage: (
      message: { type: string; port: MessagePort },
      options: WindowPostMessageOptions,
    ) => replies.push({ message, options }),
  };
  return { target, opened, forwarded, bridge, replies, source };
}

describe("createPreviewPageBridge", () => {
  it("answers a preview-connect with a control port", async () => {
    const { target, opened, replies, source, bridge } = setup();
    target.dispatchEvent(messageEvent({ type: "webnode:preview-connect" }, PREVIEW, source));
    expect(opened).toHaveLength(1);
    expect(opened[0][0]).toBe(5173);
    expect(replies).toHaveLength(1);
    const { message, options } = replies[0];
    expect(message.type).toBe("webnode:preview-port");
    expect(options).toEqual({ targetOrigin: PREVIEW, transfer: [message.port] });

    // The two ends are linked.
    const received = new Promise((resolve) => {
      opened[0][1].onmessage = (event) => resolve(event.data);
    });
    message.port.postMessage("ping");
    expect(await received).toBe("ping");
    opened[0][1].close();
    message.port.close();
    bridge.dispose();
  });

  it("ignores unknown origins, messages and sources", () => {
    const { target, opened, forwarded, source, bridge } = setup();
    target.dispatchEvent(
      messageEvent({ type: "webnode:preview-connect" }, "https://evil.example", source),
    );
    target.dispatchEvent(messageEvent({ type: "something-else" }, PREVIEW, source));
    target.dispatchEvent(messageEvent("webnode:preview-connect", PREVIEW, source));
    target.dispatchEvent(messageEvent({ type: "webnode:preview-connect" }, PREVIEW, null));
    target.dispatchEvent(
      messageEvent(
        { type: "webnode:preview-message", payload: { type: "X" } },
        "https://evil.example",
        source,
      ),
    );
    expect(opened).toHaveLength(0);
    expect(forwarded).toHaveLength(0);
    bridge.dispose();
  });

  it("relays forwarded preview errors with the port", () => {
    const { target, forwarded, source, bridge } = setup();
    target.dispatchEvent(
      messageEvent(
        {
          type: "webnode:preview-message",
          payload: { type: "PREVIEW_UNCAUGHT_EXCEPTION", message: "boom" },
        },
        PREVIEW,
        source,
      ),
    );
    target.dispatchEvent(
      messageEvent({ type: "webnode:preview-message", payload: "nope" }, PREVIEW, source),
    );
    expect(forwarded).toEqual([
      { type: "PREVIEW_UNCAUGHT_EXCEPTION", message: "boom", port: 5173 },
    ]);
    bridge.dispose();
  });

  it("stops listening on dispose", () => {
    const { target, opened, source, bridge } = setup();
    bridge.dispose();
    target.dispatchEvent(messageEvent({ type: "webnode:preview-connect" }, PREVIEW, source));
    expect(opened).toHaveLength(0);
  });
});

function fakeIframe(
  src: string,
  contentWindow: { postMessage: (message: unknown, origin: string) => void } | null,
) {
  const iframe = Object.assign(new EventTarget(), { src, contentWindow });
  const assignments: string[] = [];
  let current = src;
  Object.defineProperty(iframe, "src", {
    get: () => current,
    set: (value: string) => {
      current = value;
      assignments.push(value);
    },
  });
  return { iframe: iframe as unknown as HTMLIFrameElement, assignments };
}

describe("reloadPreview", () => {
  it("asks the preview to reload itself and resolves on load", async () => {
    const posted: [unknown, string][] = [];
    const { iframe, assignments } = fakeIframe(`${PREVIEW}/app/`, {
      postMessage: (message, origin) => {
        posted.push([message, origin]);
        setTimeout(() => iframe.dispatchEvent(new Event("load")), 1);
      },
    });
    await reloadPreview(iframe, 1000);
    expect(posted).toEqual([[{ type: "webnode:reload" }, PREVIEW]]);
    expect(assignments).toHaveLength(0);
  });

  it("falls back to re-assigning src when the preview does not answer", async () => {
    vi.useFakeTimers();
    try {
      const { iframe, assignments } = fakeIframe(`${PREVIEW}/`, { postMessage: () => {} });
      const done = reloadPreview(iframe, 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(assignments).toEqual([`${PREVIEW}/`]);
      iframe.dispatchEvent(new Event("load"));
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-assigns src at once when there is no content window", async () => {
    vi.useFakeTimers();
    try {
      const { iframe, assignments } = fakeIframe(`${PREVIEW}/`, null);
      const done = reloadPreview(iframe, 100);
      expect(assignments).toEqual([`${PREVIEW}/`]);
      await vi.advanceTimersByTimeAsync(100);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });
});
