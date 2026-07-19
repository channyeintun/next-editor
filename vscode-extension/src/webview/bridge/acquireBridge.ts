import { parseHostMessage, type HostToWebviewMessage, type WebviewToHostMessage } from "./protocol";

type VsCodeApi = {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

declare function acquireVsCodeApi(): VsCodeApi;

export type Bridge = {
  post(message: WebviewToHostMessage): void;
  onMessage(handler: (message: HostToWebviewMessage) => void): () => void;
  getState(): unknown;
  setState(state: unknown): void;
};

let bridge: Bridge | undefined;

// acquireVsCodeApi may only be called once per webview session. Every
// incoming message is schema-validated; invalid input is dropped.
export function acquireBridge(): Bridge {
  if (bridge) {
    return bridge;
  }
  const api = acquireVsCodeApi();
  bridge = {
    post: (message) => api.postMessage(message),
    onMessage: (handler) => {
      const listener = (event: MessageEvent) => {
        const message = parseHostMessage(event.data);
        if (message) {
          handler(message);
        }
      };
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
    getState: () => api.getState(),
    setState: (state) => api.setState(state),
  };
  return bridge;
}
