// The editor-page end of the preview: answers a preview window's request for a
// control port (handing the other end to the gateway), relays forwarded preview
// errors, and reloads a preview iframe.
import { isMessageOfType } from "./protocol";
import type {
  PreviewConnectMessage,
  PreviewForwardedMessage,
  PreviewPortMessage,
  PreviewReloadMessage,
} from "./protocol";

export interface PreviewPageBridgeOptions {
  /** The server port a preview origin stands for, or null when `origin` is not one of this session's preview origins. */
  serverPortForOrigin(origin: string): number | null;
  /** Hands the gateway its end of a new control port. */
  openControlPort(serverPort: number, port: MessagePort): void;
  /** A forwarded preview error, with `port` added. */
  onPreviewMessage(message: Record<string, unknown>): void;
}

/** The window the bridge listens on (the editor's own `window`, or a test double). */
export type PreviewBridgeWindow = Pick<Window, "addEventListener" | "removeEventListener">;

/** A message source a reply can be posted to (a preview window). */
interface ReplyTarget {
  postMessage(message: unknown, options: WindowPostMessageOptions): void;
}

function isReplyTarget(
  source: MessageEventSource | null,
): source is MessageEventSource & ReplyTarget {
  return source !== null && typeof (source as Partial<ReplyTarget>).postMessage === "function";
}

/** Starts answering preview windows; `dispose` stops. */
export function createPreviewPageBridge(
  options: PreviewPageBridgeOptions,
  target: PreviewBridgeWindow = window,
): { dispose(): void } {
  const onMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      !isMessageOfType<PreviewConnectMessage>(data, "webnode:preview-connect") &&
      !isMessageOfType<PreviewForwardedMessage>(data, "webnode:preview-message")
    ) {
      return;
    }
    const serverPort = options.serverPortForOrigin(event.origin);
    if (serverPort === null) {
      return;
    }
    if (data.type === "webnode:preview-connect") {
      const source = event.source;
      if (!isReplyTarget(source)) {
        return;
      }
      const channel = new MessageChannel();
      options.openControlPort(serverPort, channel.port1);
      const reply: PreviewPortMessage = { type: "webnode:preview-port", port: channel.port2 };
      source.postMessage(reply, { targetOrigin: event.origin, transfer: [channel.port2] });
      return;
    }
    const payload = data.payload;
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
      options.onPreviewMessage({ ...payload, port: serverPort });
    }
  };
  target.addEventListener("message", onMessage);
  return {
    dispose(): void {
      target.removeEventListener("message", onMessage);
    },
  };
}

/** Reloads the preview in `iframe`, falling back to re-assigning its `src`. */
export function reloadPreview(iframe: HTMLIFrameElement, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onLoad = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      iframe.removeEventListener("load", onLoad);
      resolve();
    };
    iframe.addEventListener("load", onLoad);
    const fallback = () => {
      if (settled) {
        return;
      }
      // Re-assigning the same URL navigates again (the injected client may be gone).
      const src = iframe.src;
      iframe.src = src;
      timer = setTimeout(onLoad, timeoutMs);
    };
    const contentWindow = iframe.contentWindow;
    let origin: string | null = null;
    try {
      origin = new URL(iframe.src).origin;
    } catch {
      origin = null;
    }
    if (!contentWindow || origin === null || origin === "null") {
      fallback();
      return;
    }
    const message: PreviewReloadMessage = { type: "webnode:reload" };
    contentWindow.postMessage(message, origin);
    timer = setTimeout(fallback, timeoutMs);
  });
}
