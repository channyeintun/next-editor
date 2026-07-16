export enum PreviewMessageType {
  UncaughtException = "PREVIEW_UNCAUGHT_EXCEPTION",
  UnhandledRejection = "PREVIEW_UNHANDLED_REJECTION",
  ConsoleError = "PREVIEW_CONSOLE_ERROR",
}

export interface PreviewMessage {
  type: PreviewMessageType;
  previewId: string;
  port: number;
  pathname: string;
  search: string;
  hash: string;
  message?: string;
  stack?: string;
  args?: unknown[];
}

export function isPreviewMessage(data: unknown): data is PreviewMessage {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Partial<PreviewMessage>;
  if (!Object.values(PreviewMessageType).includes(message.type as PreviewMessageType)
    || typeof message.previewId !== "string"
    || typeof message.port !== "number"
    || !Number.isInteger(message.port)
    || message.port < 1
    || message.port > 65_535
    || typeof message.pathname !== "string"
    || typeof message.search !== "string"
    || typeof message.hash !== "string") {
    return false;
  }
  if (message.type === PreviewMessageType.ConsoleError) {
    return Array.isArray(message.args) && typeof message.stack === "string";
  }
  return typeof message.message === "string"
    && (message.stack === undefined || typeof message.stack === "string");
}

export function listenForPreviewMessages(
  allowedOrigin: (origin: string, message: PreviewMessage) => boolean,
  listener: (message: PreviewMessage) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: MessageEvent) => {
    if (isPreviewMessage(event.data) && allowedOrigin(event.origin, event.data)) listener(event.data);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

function scriptLiteral(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function createPreviewErrorForwarder(options: {
  targetOrigin: string;
  previewId: string;
  mode: true | "exceptions-only";
}): string {
  const consoleForwarding = options.mode === true
    ? `
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    originalConsoleError(...args);
    send({ type: "${PreviewMessageType.ConsoleError}", args, stack: new Error().stack || "" });
  };`
    : "";
  return `(() => {
  const targetOrigin = ${scriptLiteral(options.targetOrigin)};
  const previewId = ${scriptLiteral(options.previewId)};
  const port = (() => {
    const host = location.hostname.match(/^p(\\d+)-/);
    if (host) return Number(host[1]);
    const path = location.pathname.match(/^\\/preview\\/[^/]+\\/(\\d+)(?:\\/|$)/);
    return path ? Number(path[1]) : Number(location.port) || (location.protocol === "https:" ? 443 : 80);
  })();
  const send = (payload) => {
    try {
      parent.postMessage({
        ...payload,
        previewId,
        port,
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      }, targetOrigin);
    } catch {}
  };
  addEventListener("error", (event) => {
    send({
      type: "${PreviewMessageType.UncaughtException}",
      message: event.message || String(event.error || "Uncaught exception"),
      stack: event.error && typeof event.error.stack === "string" ? event.error.stack : undefined,
    });
  });
  addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    send({
      type: "${PreviewMessageType.UnhandledRejection}",
      message: reason && typeof reason.message === "string" ? reason.message : String(reason),
      stack: reason && typeof reason.stack === "string" ? reason.stack : undefined,
    });
  });${consoleForwarding}
})();`;
}
