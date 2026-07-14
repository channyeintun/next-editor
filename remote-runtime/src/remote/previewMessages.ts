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
  return Object.values(PreviewMessageType).includes(message.type as PreviewMessageType)
    && typeof message.previewId === "string"
    && Number.isInteger(message.port)
    && typeof message.pathname === "string";
}

export function listenForPreviewMessages(
  allowedOrigin: (origin: string) => boolean,
  listener: (message: PreviewMessage) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: MessageEvent) => {
    if (allowedOrigin(event.origin) && isPreviewMessage(event.data)) listener(event.data);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
