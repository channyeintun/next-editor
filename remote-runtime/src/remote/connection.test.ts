import { describe, expect, it } from "vitest";
import { RCP_LIMITS } from "../rcp/types";
import { RcpConnection } from "./connection";

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 0;
  binaryType = "";
  sent: Array<string | ArrayBufferLike> = [];
  static instances: MockWebSocket[] = [];

  constructor(_url: URL) {
    super();
    MockWebSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }

  send(data: string | ArrayBufferLike): void {
    this.sent.push(data);
    if (typeof data !== "string") return;
    const frame = JSON.parse(data) as { t: string; id: number; m: string };
    if (frame.t !== "req") return;
    const result = frame.m === "session.hello"
      ? { workdir: "/workspace/project", agentVersion: "test", resumed: MockWebSocket.instances.length > 1, resumeToken: "resume-1" }
      : {};
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ t: "ok", id: frame.id, r: result }),
    })));
  }

  close(): void { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

describe("RCP connection", () => {
  it("opens with hello and correlates requests", async () => {
    MockWebSocket.instances = [];
    const connection = new RcpConnection({
      wsUrl: "ws://agent.test/ws",
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    await connection.open();
    expect(connection.workdir).toBe("/workspace/project");
    await expect(connection.request("session.ping", {})).resolves.toEqual({});
    connection.close();
  });

  it("reconnects with the resume token and invokes re-registration hooks", async () => {
    MockWebSocket.instances = [];
    const connection = new RcpConnection({
      wsUrl: "ws://agent.test/ws",
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      reconnectDelaysMs: [0],
    });
    await connection.open();
    let reconnected = 0;
    connection.onReconnect(() => { reconnected += 1; });
    MockWebSocket.instances[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(reconnected).toBe(1);
    const hello = MockWebSocket.instances[1]!.sent.find((item) =>
      typeof item === "string" && JSON.parse(item).m === "session.hello"
    );
    expect(JSON.parse(hello as string).p.resumeToken).toBe("resume-1");
    connection.close();
  });

  it("rejects oversized outbound control frames before registering a request", async () => {
    MockWebSocket.instances = [];
    const connection = new RcpConnection({
      wsUrl: "ws://agent.test/ws",
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    await connection.open();
    expect(() => connection.beginRequest("proc.spawn", {
      cmd: "tool",
      args: [],
      env: { HUGE: "x".repeat(RCP_LIMITS.maxControlFrameBytes) },
      output: true,
    })).toThrow("ELIMIT:");
    await expect(connection.request("session.ping", {})).resolves.toEqual({});
    connection.close();
  });
});
