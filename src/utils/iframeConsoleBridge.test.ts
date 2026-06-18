import { describe, expect, it, vi } from "vite-plus/test";
import {
  createIframeConsoleBridgeScript,
  IFRAME_CONSOLE_MESSAGE_TYPE,
} from "./iframeConsoleBridge";

function installBridge(frameWindow: object, setupMarker = "__TEST_CONSOLE_BRIDGE__") {
  const install = new Function("window", createIframeConsoleBridgeScript(setupMarker));

  install(frameWindow);
}

describe("createIframeConsoleBridgeScript", () => {
  it("posts serialized console arguments and preserves the original console call", () => {
    const originalLog = vi.fn<(...args: unknown[]) => void>();
    const postMessage = vi.fn<(message: unknown, targetOrigin: string) => void>();
    const frameWindow = {
      console: {
        log: originalLog,
      },
      location: {
        hash: "#section",
        pathname: "/preview",
        search: "?mode=test",
      },
      parent: {
        postMessage,
      },
    };

    installBridge(frameWindow);
    frameWindow.console.log("hello", { answer: 42 });

    expect(originalLog).toHaveBeenCalledWith("hello", { answer: 42 });
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: IFRAME_CONSOLE_MESSAGE_TYPE,
        payload: {
          method: "log",
          args: ["hello", '{"answer":42}'],
          pathname: "/preview?mode=test#section",
        },
      },
      "*",
    );
  });

  it("serializes errors with useful text", () => {
    const postMessage = vi.fn<(message: unknown, targetOrigin: string) => void>();
    const frameWindow = {
      console: {
        error: vi.fn<(...args: unknown[]) => void>(),
      },
      location: {
        hash: "",
        pathname: "/",
        search: "",
      },
      parent: {
        postMessage,
      },
    };

    installBridge(frameWindow);
    frameWindow.console.error(new Error("Boom"));

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      type: IFRAME_CONSOLE_MESSAGE_TYPE,
      payload: {
        method: "error",
        pathname: "/",
      },
    });
    const firstMessage = postMessage.mock.calls[0][0] as { payload: { args: string[] } };
    expect(firstMessage.payload.args[0]).toContain("Boom");
  });

  it("does not wrap console methods more than once for the same marker", () => {
    const postMessage = vi.fn<(message: unknown, targetOrigin: string) => void>();
    const frameWindow = {
      console: {
        warn: vi.fn<(...args: unknown[]) => void>(),
      },
      location: {
        hash: "",
        pathname: "/",
        search: "",
      },
      parent: {
        postMessage,
      },
    };

    installBridge(frameWindow);
    installBridge(frameWindow);
    frameWindow.console.warn("once");

    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
