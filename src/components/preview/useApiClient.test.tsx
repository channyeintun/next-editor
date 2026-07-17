import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ApiClientStoreProvider,
  useApiClientStoreInstance,
} from "../../contexts/ApiClientStoreContext";
import type { ApiClientStoreInstance } from "../../stores/apiClientStore";
import {
  API_CLIENT_CANCEL_MESSAGE_TYPE,
  API_CLIENT_REQUEST_MESSAGE_TYPE,
} from "../../utils/apiClientBridge";
import type { ApiClientRecordedResult } from "../../types/slides";
import { useApiClient } from "./useApiClient";

interface CapturedApiClient {
  api: ReturnType<typeof useApiClient>;
  store: ApiClientStoreInstance;
}

interface ApiClientRequestMessage {
  type: typeof API_CLIENT_REQUEST_MESSAGE_TYPE;
  payload: { id: string };
}

function expectApiClientRequestMessage(value: unknown): asserts value is ApiClientRequestMessage {
  expect(value).toEqual(
    expect.objectContaining({
      type: API_CLIENT_REQUEST_MESSAGE_TYPE,
      payload: expect.objectContaining({ id: expect.any(String) }),
    }),
  );
}

function renderApiClient(runtimePreviewUrl = "https://preview.example.com/app") {
  const postMessage = vi.fn<(message: unknown, targetOrigin: string) => void>();
  const iframeRef = {
    current: { contentWindow: { postMessage } } as unknown as HTMLIFrameElement,
  };
  const captured = { current: null as CapturedApiClient | null };
  const onResponseReceived = vi.fn<(result: ApiClientRecordedResult) => void>();

  function Harness({ url }: { url: string }) {
    captured.current = {
      api: useApiClient({ iframeRef, runtimePreviewUrl: url, onResponseReceived }),
      store: useApiClientStoreInstance(),
    };
    return null;
  }

  const view = render(
    <ApiClientStoreProvider>
      <Harness url={runtimePreviewUrl} />
    </ApiClientStoreProvider>,
  );
  if (!captured.current) throw new Error("Expected API client harness");

  return {
    captured: captured as { current: CapturedApiClient },
    onResponseReceived,
    postMessage,
    rerenderUrl: (url: string) =>
      view.rerender(
        <ApiClientStoreProvider>
          <Harness url={url} />
        </ApiClientStoreProvider>,
      ),
    unmount: view.unmount,
  };
}

describe("useApiClient cancellation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts on timeout and records the immutable sent request", async () => {
    const harness = renderApiClient();
    const { store } = harness.captured.current;
    act(() => {
      store.trigger.setMethod({ method: "POST" });
      store.trigger.setPath({ path: "/sent" });
      store.trigger.setBody({ body: "sent body" });
      store.trigger.addHeader();
      store.trigger.updateHeader({ index: 0, key: "X-Sent", value: "yes" });
      harness.captured.current.api.send();
    });
    const requestMessage = harness.postMessage.mock.calls[0]?.[0];
    expectApiClientRequestMessage(requestMessage);

    act(() => {
      store.trigger.setMethod({ method: "DELETE" });
      store.trigger.setPath({ path: "/next" });
      store.trigger.setBody({ body: "next body" });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(harness.postMessage).toHaveBeenLastCalledWith(
      {
        type: API_CLIENT_CANCEL_MESSAGE_TYPE,
        payload: { id: requestMessage.payload.id },
      },
      "https://preview.example.com",
    );
    const context = store.getSnapshot().context;
    expect(context.history[0]).toMatchObject({
      method: "POST",
      path: "/sent",
      body: "sent body",
      headers: [{ key: "X-Sent", value: "yes", enabled: true }],
      result: { ok: false, error: { error: "Request timed out" } },
    });
    expect(context.path).toBe("/next");
    expect(harness.onResponseReceived).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: "Request timed out" }),
    );
  });

  it("cancels on iframe/runtime replacement and ignores a late result", () => {
    const harness = renderApiClient();
    act(() => harness.captured.current.api.send());
    const request = harness.postMessage.mock.calls[0]?.[0];
    expectApiClientRequestMessage(request);

    act(() => harness.rerenderUrl("https://replacement.example.com/app"));
    expect(harness.postMessage).toHaveBeenCalledWith(
      {
        type: API_CLIENT_CANCEL_MESSAGE_TYPE,
        payload: { id: request.payload.id },
      },
      "https://preview.example.com",
    );

    act(() => {
      harness.captured.current.api.handleResponse({
        id: request.payload.id,
        ok: true,
        status: 200,
        statusText: "OK",
        headers: [],
        body: "late",
        durationMs: 1,
      });
    });
    const context = harness.captured.current.store.getSnapshot().context;
    expect(context.sending).toBe(false);
    expect(context.history).toEqual([]);
    expect(context.result).toBeNull();
  });
});
