import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteContainer } from "./RemoteContainer";

class FailingWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = "";

  constructor(_url: URL) {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("error")));
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("RemoteContainer boot lifecycle", () => {
  it("deletes a provisioned session when the WebSocket handshake fails", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: "session-1",
            wsUrl: "ws://worker.test/api/runtime/sessions/session-1/ws",
            previewUrlTemplate: "https://p{{port}}-session-1.preview.test",
            token: "session-token",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FailingWebSocket);

    await expect(
      RemoteContainer.boot({
        endpoint: "http://worker.test/api/runtime",
        authorizationToken: "app-token",
      }),
    ).rejects.toThrow("WebSocket open failed");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://worker.test/api/runtime/sessions/session-1");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "DELETE",
      headers: { Authorization: "Bearer session-token" },
    });
  });
});
