import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import GoogleOneTap from "./GoogleOneTap";

const gsi = vi.hoisted(() => ({
  initialize: vi.fn<(config: { client_id: string }) => void>(),
  prompt: vi.fn<() => void>(),
  cancel: vi.fn<() => void>(),
  load: vi.fn<() => Promise<unknown>>(),
  signIn: vi.fn<(credential: string) => void>(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { clientId: "client-1" } }),
}));
vi.mock("./useAuth", () => ({ useGoogleCredentialSignIn: () => ({ mutate: gsi.signIn }) }));
vi.mock("./googleIdentity", () => ({ loadGoogleIdentity: gsi.load }));

beforeEach(() => {
  vi.clearAllMocks();
  gsi.load.mockResolvedValue({
    initialize: gsi.initialize,
    prompt: gsi.prompt,
    cancel: gsi.cancel,
  });
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GoogleOneTap", () => {
  it("loads Google's script only after the page's load event and an idle moment", async () => {
    render(<GoogleOneTap />);
    act(() => vi.runAllTimers());
    expect(gsi.load).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("load"));
    expect(gsi.load).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    expect(gsi.load).toHaveBeenCalledTimes(1);
    expect(gsi.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: "client-1", auto_select: true }),
    );
    expect(gsi.prompt).toHaveBeenCalledTimes(1);
  });

  it("loads nothing when it unmounts first, as on sign-in", () => {
    const { unmount } = render(<GoogleOneTap />);
    unmount();

    window.dispatchEvent(new Event("load"));
    vi.runAllTimers();
    expect(gsi.load).not.toHaveBeenCalled();
  });
});
