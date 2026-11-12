import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createStudioPreviewCommandBridgeScript,
  requestStudioPreviewCommand,
  STUDIO_PREVIEW_COMMAND_MESSAGE_TYPE,
  STUDIO_PREVIEW_COMMAND_RESPONSE_MESSAGE_TYPE,
  STUDIO_PREVIEW_FRAME_FALLBACK_MS,
  type StudioPreviewCommand,
} from "./iframeStudioCommandBridge";

describe("createStudioPreviewCommandBridgeScript", () => {
  it("embeds the setup marker as a JSON string literal", () => {
    expect(
      createStudioPreviewCommandBridgeScript("__NEXT_EDITOR_RUNTIME_STUDIO_COMMAND__"),
    ).toContain('var marker = "__NEXT_EDITOR_RUNTIME_STUDIO_COMMAND__";');
  });

  it("guards on the exact marker even when it holds quotes or replacement patterns", () => {
    const marker = `__TEST_"MARKER"_$&_$1__`;
    const script = createStudioPreviewCommandBridgeScript(marker);
    expect(script).toContain(`var marker = ${JSON.stringify(marker)};`);

    const frameWindow: Record<string, unknown> = {
      addEventListener: vi.fn<() => void>(),
    };
    new Function("window", script)(frameWindow);

    expect(frameWindow[marker]).toBe(true);
    expect(frameWindow.addEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });
});

/**
 * Runs the injected script against a stand-in frame window whose animation
 * frames are under the test's control, the way a hidden Chrome tab withholds
 * them. The document, elements and events are jsdom's.
 */
function mountBridge(requestAnimationFrame: (callback: () => void) => number) {
  const parent = { postMessage: vi.fn<(message: unknown, origin: string) => void>() };
  let onMessage: ((event: { source: unknown; data: unknown }) => void) | undefined;
  const frameWindow = {
    parent,
    location: { pathname: "/", search: "", hash: "" },
    addEventListener: (type: string, listener: typeof onMessage) => {
      if (type === "message") onMessage = listener;
    },
    requestAnimationFrame: vi.fn<(callback: () => void) => number>(requestAnimationFrame),
    cancelAnimationFrame: vi.fn<(handle: number) => void>(),
    // Late-bound so the fake timers installed by each test apply.
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  };
  new Function("window", createStudioPreviewCommandBridgeScript("__TEST_BRIDGE__"))(frameWindow);
  let nextId = 0;
  return {
    frameWindow,
    send(command: StudioPreviewCommand) {
      const id = `request-${nextId++}`;
      onMessage?.({
        source: parent,
        data: { type: STUDIO_PREVIEW_COMMAND_MESSAGE_TYPE, payload: { id, command } },
      });
      return id;
    },
    acknowledged(id: string): Record<string, unknown> | undefined {
      const call = parent.postMessage.mock.calls.find(
        ([message]) =>
          (message as { type: string; payload: { id: string } }).type ===
            STUDIO_PREVIEW_COMMAND_RESPONSE_MESSAGE_TYPE &&
          (message as { payload: { id: string } }).payload.id === id,
      );
      return call ? (call[0] as { payload: Record<string, unknown> }).payload : undefined;
    },
  };
}

describe("studio preview bridge without animation frames", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const neverFrames = () => 1;

  it("acknowledges a ping at once, without waiting for a frame", async () => {
    vi.useFakeTimers();
    const bridge = mountBridge(neverFrames);
    const id = bridge.send({ type: "ping" });
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.acknowledged(id)).toMatchObject({ result: { command: "ping", route: "/" } });
    expect(bridge.frameWindow.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("answers click and inspect after the fallback timeout when no frame comes", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button data-testid="increment">Count 0</button>';
    const button = document.querySelector("button")!;
    button.addEventListener("click", () => {
      button.textContent = "Count 1";
    });
    const bridge = mountBridge(neverFrames);

    const click = bridge.send({ type: "click", target: { testId: "increment" } });
    const inspect = bridge.send({ type: "inspect", target: { testId: "increment" } });
    await vi.advanceTimersByTimeAsync(STUDIO_PREVIEW_FRAME_FALLBACK_MS - 1);
    expect(bridge.acknowledged(click)).toBeUndefined();
    expect(bridge.acknowledged(inspect)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.acknowledged(click)).toMatchObject({
      result: { command: "click", target: { testId: "increment", text: "Count 1" } },
    });
    expect(bridge.acknowledged(inspect)).toMatchObject({
      result: { command: "inspect", target: { testId: "increment", text: "Count 1" } },
    });
  });

  it("still answers on the next frame in a visible tab, cancelling the fallback", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button data-testid="increment">Count 0</button>';
    const bridge = mountBridge((callback) => {
      setTimeout(callback, 16);
      return 7;
    });

    const id = bridge.send({ type: "click", target: { testId: "increment" } });
    await vi.advanceTimersByTimeAsync(16);

    expect(bridge.acknowledged(id)).toMatchObject({ result: { command: "click" } });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("studio preview bridge content box", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  const neverFrames = () => 1;

  /** Stubs the Range jsdom lays nothing out for, so the bridge reads `rect` as its contents' box. */
  function stubContentRect(rect: { left: number; top: number; width: number; height: number }) {
    vi.spyOn(document, "createRange").mockReturnValue({
      selectNodeContents: () => {},
      getBoundingClientRect: () => rect,
    } as unknown as Range);
  }

  async function inspectTitle() {
    document.body.innerHTML = '<h1 data-testid="title">Scores</h1>';
    const bridge = mountBridge(neverFrames);
    const id = bridge.send({ type: "inspect", target: { testId: "title" } });
    await vi.advanceTimersByTimeAsync(STUDIO_PREVIEW_FRAME_FALLBACK_MS);
    const result = bridge.acknowledged(id)?.result as
      | { targetBox: Record<string, unknown> }
      | undefined;
    if (!result) throw new Error("The bridge did not acknowledge the inspect");
    return result.targetBox;
  }

  // A heading is as wide as its column while its words end early; the pointer
  // aims under the words, so the bridge reports where they are.
  it("reports the box of an element's contents when it has one", async () => {
    vi.useFakeTimers();
    stubContentRect({ left: 20, top: 104, width: 200, height: 32 });

    expect((await inspectTitle()).content).toEqual({ left: 20, top: 104, width: 200, height: 32 });
  });

  it("leaves the content box out when the contents have no size", async () => {
    vi.useFakeTimers();
    stubContentRect({ left: 0, top: 0, width: 0, height: 0 });

    const targetBox = await inspectTitle();
    expect(targetBox).toBeDefined();
    expect(targetBox.content).toBeUndefined();
  });
});

describe("requestStudioPreviewCommand target box validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  const box = {
    left: 0,
    top: 100,
    width: 800,
    height: 40,
    viewportWidth: 800,
    viewportHeight: 600,
  };

  /** Sends an inspect and answers it from the frame with `targetBox`. */
  function answerWith(targetBox: unknown) {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const frameWindow = iframe.contentWindow as Window;
    const postMessage = vi.spyOn(frameWindow, "postMessage").mockImplementation(() => {});
    const request = requestStudioPreviewCommand(
      iframe,
      { type: "inspect", target: { testId: "title" } },
      { signal: new AbortController().signal, timeoutMs: 1_000 },
    );
    const [message] = postMessage.mock.calls[0] as [{ payload: { id: string } }];
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frameWindow,
        data: {
          type: STUDIO_PREVIEW_COMMAND_RESPONSE_MESSAGE_TYPE,
          payload: {
            id: message.payload.id,
            result: { command: "inspect", route: "/", scrollLeft: 0, scrollTop: 0, targetBox },
          },
        },
      }),
    );
    return request;
  }

  it("accepts a well-formed content box", async () => {
    const targetBox = { ...box, content: { left: 20, top: 104, width: 200, height: 32 } };

    await expect(answerWith(targetBox)).resolves.toMatchObject({ targetBox });
  });

  it("rejects a content box with a field that is not a number", async () => {
    const targetBox = { ...box, content: { left: "20", top: 104, width: 200, height: 32 } };

    await expect(answerWith(targetBox)).rejects.toThrow(
      "The preview returned an invalid command acknowledgement",
    );
  });
});
