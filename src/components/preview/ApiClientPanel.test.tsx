import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ApiClientStoreProvider,
  useApiClientStoreInstance,
} from "../../contexts/ApiClientStoreContext";
import type { ApiClientStoreInstance } from "../../stores/apiClientStore";
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
