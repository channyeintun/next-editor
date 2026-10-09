import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ApiClientStoreProvider,
  useApiClientStoreInstance,
} from "../../contexts/ApiClientStoreContext";
import type { ApiClientReplayPayload, ApiClientStoreInstance } from "../../stores/apiClientStore";
import ApiClientPanel from "./ApiClientPanel";

// The editors are irrelevant here and Monaco does not load under jsdom.
vi.mock("../../monaco", () => ({
  MonacoEditor: () => null,
  useOwnedModel: () => null,
  toInternalModelUri: (name: string) => `inmemory://internal/${name}`,
}));

function renderPanel() {
  const captured: { store: ApiClientStoreInstance | null } = { store: null };
  function CaptureStore() {
    captured.store = useApiClientStoreInstance();
    return null;
  }
  render(
    <ApiClientStoreProvider>
      <CaptureStore />
      <ApiClientPanel onSend={() => undefined} runtimeReady />
    </ApiClientStoreProvider>,
  );
  if (!captured.store) throw new Error("missing API client store");
  return captured.store;
}

describe("ApiClientPanel response", () => {
  it("labels a truncated response with the size the response really had", () => {
    const store = renderPanel();

    act(() => {
      // A replayed result: its body was cut to the retained limit, while
      // bodyBytes keeps what the server sent.
      store.trigger.applyReplayState({
        method: "GET",
        path: "/api/items",
        body: "",
        headers: [],
        sending: false,
        history: [],
        result: {
          ok: true,
          response: {
            status: 200,
            statusText: "OK",
            headers: [],
            body: '{"items":[]}',
            durationMs: 12,
            truncated: true,
            bodyBytes: 800_000,
          },
        },
      });
    });

    expect(screen.getByText("781.3 KB")).toBeInTheDocument();
    expect(screen.getByText("Truncated")).toBeInTheDocument();
  });
});

describe("ApiClientPanel status announcements", () => {
  function replayState(store: ApiClientStoreInstance, patch: Partial<ApiClientReplayPayload>) {
    act(() => {
      store.trigger.applyReplayState({
        method: "GET",
        path: "/api/items",
        body: "",
        headers: [],
        sending: false,
        history: [],
        result: null,
        ...patch,
      });
    });
  }

  it("announces the request lifecycle through one status region", () => {
    const store = renderPanel();
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();

    replayState(store, { sending: true });
    expect(screen.getByRole("status")).toHaveTextContent("Sending request");

    replayState(store, {
      result: {
        ok: true,
        response: {
          status: 200,
          statusText: "OK",
          headers: [],
          body: "{}",
          durationMs: 12,
          bodyBytes: 2,
        },
      },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Response 200 OK, 12 ms");

    replayState(store, {
      result: { ok: false, error: { error: "connect ECONNREFUSED", durationMs: 4 } },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Request failed: connect ECONNREFUSED");
    expect(screen.getByRole("status")).toBe(status);
  });

  it("announces that the server is not ready yet", () => {
    render(
      <ApiClientStoreProvider>
        <ApiClientPanel onSend={() => undefined} runtimeReady={false} />
      </ApiClientStoreProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the server to start");
  });
});

describe("ApiClientPanel request controls", () => {
  it("names the method select and every per-header control", () => {
    const store = renderPanel();

    act(() => {
      store.trigger.addHeader();
    });

    expect(screen.getByRole("combobox", { name: "HTTP method" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Send header 1" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Header 1 name" })).toHaveAttribute(
      "placeholder",
      "Header",
    );
    expect(screen.getByRole("textbox", { name: "Header 1 value" })).toHaveAttribute(
      "placeholder",
      "Value",
    );
    expect(screen.getByRole("button", { name: "Remove header 1" })).toBeInTheDocument();
  });
});
