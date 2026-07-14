import { describe, expect, it } from "vitest";
import { RcpConnection } from "./connection";

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 0;
  binaryType = "";
  sent: Array<string | ArrayBufferLike> = [];

  constructor(_url: URL) {
    super();
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }

  send(data: string | ArrayBufferLike): void {
    this.sent.push(data);
    if (typeof data !== "string") return;
    const frame = JSON.parse(data) as { t: string; id: number; m: string };
    if (frame.t !== "req") return;
    const result = frame.m === "session.hello"
      ? { workdir: "/workspace/project", agentVersion: "test", resumed: false }
      : {};
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ t: "ok", id: frame.id, r: result }),
    })));
  }

  close(): void { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

describe("RCP connection", () => {
  it("opens with hello and correlates requests", async () => {
    const connection = new RcpConnection({
      wsUrl: "ws://agent.test/ws",
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    await connection.open();
    expect(connection.workdir).toBe("/workspace/project");
    await expect(connection.request("session.ping", {})).resolves.toEqual({});
    connection.close();
  });
});
