import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import HowardPanel, { type HowardPanelProps } from "./HowardPanel";

const SERVER_URL_KEY = "next-editor:studio:howard-server-url";
const SERVER_MODEL_KEY = "next-editor:studio:howard-server-model";
const MODEL = "Howard-0.6B-Q8_0.gguf";

const onServerChange = vi.fn<HowardPanelProps["onServerChange"]>();
const fetchSpy = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

function modelsResponse(id = MODEL): Response {
  return new Response(JSON.stringify({ object: "list", data: [{ id }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPanel(disabled = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HowardPanel disabled={disabled} onServerChange={onServerChange} />
    </QueryClientProvider>,
  );
}

function lastReport() {
  return onServerChange.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  fetchSpy.mockImplementation(() => Promise.resolve(modelsResponse()));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HowardPanel", () => {
  it("asks the default server for its model and reports it", async () => {
    renderPanel();
    expect(onServerChange).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(lastReport()).toEqual({ modelId: MODEL, reachable: true, reason: null }),
    );
    expect(String(fetchSpy.mock.calls[0][0])).toBe("http://127.0.0.1:8080/v1/models");
    expect(screen.getByRole("status").textContent).toContain(MODEL);
    expect(localStorage.getItem(SERVER_MODEL_KEY)).toBe(MODEL);
  });

  it("reports why nothing can be narrated when no server answers", async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    renderPanel();

    await waitFor(() => expect(lastReport()?.reachable).toBe(false));
    expect(lastReport()).toEqual({
      modelId: null,
      reachable: false,
      reason: expect.stringContaining("no server answers at http://127.0.0.1:8080"),
    });
    expect(screen.getByRole("status").textContent).toContain("no server answers");
  });

  it("shows the command that starts Howard while no server answers, and copies it", async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderPanel();
    await waitFor(() => expect(lastReport()?.reachable).toBe(false));

    const command = screen.getByText(/^curl -fsSL .*\/scripts\/howard\.sh \| sh$/).textContent;
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(command);
  });

  it("does not show the start command while the server answers", async () => {
    renderPanel();
    await waitFor(() => expect(lastReport()?.reachable).toBe(true));

    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("keeps the model a server named earlier while none answers", async () => {
    localStorage.setItem(SERVER_MODEL_KEY, MODEL);
    fetchSpy.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    renderPanel();

    await waitFor(() => expect(lastReport()?.modelId).toBe(MODEL));
    expect(lastReport()?.reachable).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("still render from the narration");
  });

  it("checks the address the author stored", async () => {
    localStorage.setItem(SERVER_URL_KEY, "http://localhost:9000");
    renderPanel();

    await waitFor(() => expect(lastReport()?.reachable).toBe(true));
    expect(String(fetchSpy.mock.calls[0][0])).toBe("http://localhost:9000/v1/models");
    expect(screen.getByLabelText<HTMLInputElement>("Howard server address").value).toBe(
      "http://localhost:9000",
    );
  });

  it("stores a new address and checks it", async () => {
    renderPanel();
    await waitFor(() => expect(lastReport()?.reachable).toBe(true));
    fetchSpy.mockImplementation(() => Promise.resolve(modelsResponse("Howard-0.6B-Q4_K_M.gguf")));

    fireEvent.change(screen.getByLabelText("Howard server address"), {
      target: { value: "http://127.0.0.1:8090/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    await waitFor(() => expect(lastReport()?.modelId).toBe("Howard-0.6B-Q4_K_M.gguf"));
    expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toBe("http://127.0.0.1:8090/v1/models");
    expect(localStorage.getItem(SERVER_URL_KEY)).toBe("http://127.0.0.1:8090");
  });

  it("asks the same address again on Check", async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    renderPanel();
    await waitFor(() => expect(lastReport()?.reachable).toBe(false));
    fetchSpy.mockImplementation(() => Promise.resolve(modelsResponse()));

    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    await waitFor(() =>
      expect(lastReport()).toEqual({ modelId: MODEL, reachable: true, reason: null }),
    );
  });

  it("refuses an address that is not on this computer, without calling it", async () => {
    renderPanel();
    await waitFor(() => expect(lastReport()?.reachable).toBe(true));
    const callsBefore = fetchSpy.mock.calls.length;

    fireEvent.change(screen.getByLabelText("Howard server address"), {
      target: { value: "http://192.168.1.20:8080" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    expect(screen.getByRole("alert").textContent).toContain("Howard runs on this computer");
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
    expect(localStorage.getItem(SERVER_URL_KEY)).toBeNull();
  });

  it("holds its controls while a render runs", async () => {
    renderPanel(true);
    await waitFor(() => expect(lastReport()?.reachable).toBe(true));

    expect(screen.getByLabelText<HTMLInputElement>("Howard server address").disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Check" }).disabled).toBe(true);
  });
});
