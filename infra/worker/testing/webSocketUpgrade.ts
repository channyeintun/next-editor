import { vi } from "vitest";
import type { FakeWebSocket } from "./fakeWebSocket";

/**
 * Lets a Durable Object answer a WebSocket upgrade under Node, which has
 * neither workerd's WebSocketPair nor a Response that accepts status 101.
 * Each pair holds two sockets from `createSocket`, and a 101 response keeps
 * its `webSocket`. Call it once at the top of a test file.
 */
export function stubWebSocketUpgrade(createSocket: () => FakeWebSocket): void {
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = createSocket();
      1 = createSocket();
    },
  );
  const NodeResponse = globalThis.Response;
  vi.stubGlobal(
    "Response",
    class extends NodeResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        const isUpgrade = init?.status === 101;
        // Node refuses statuses below 200; build a 200 and report 101.
        super(body, isUpgrade ? { ...init, status: 200 } : init);
        if (isUpgrade) Object.defineProperty(this, "status", { value: 101 });
        this.webSocket = init?.webSocket ?? null;
      }
    },
  );
}
