import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AthanLabKeyStatus, AthanLabVoiceList } from "@next-editor/infra";

const athan = vi.hoisted(() => ({
  keyStatus: undefined as AthanLabKeyStatus | undefined,
  keyError: null as Error | null,
  voices: undefined as AthanLabVoiceList | undefined,
  voicesError: null as Error | null,
  saveKey: vi.fn<(apiKey: string) => Promise<unknown>>(),
  removeKey: vi.fn<() => Promise<unknown>>(),
}));

// The queries answer from `athan`; the mutations are real, so isPending and
// the settled callbacks behave as they do against the Worker.
vi.mock("@next-editor/infra", async () => {
  const { useMutation } =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  const query = (data: unknown, error: Error | null) => ({
    data,
    error,
    isFetching: false,
    refetch: () => Promise.resolve(),
  });
  return {
    athanLabErrorOf: (error: unknown) => ({
      message: error instanceof Error ? error.message : String(error),
      code: null,
    }),
    athanLabVoiceSampleUrl: (voiceId: string) => `/api/studio/athanlab/voices/${voiceId}/sample`,
    invalidateAthanLabAccount: () => Promise.resolve(),
    signInUrl: () => "/sign-in",
    useAthanLabKey: () => query(athan.keyStatus, athan.keyError),
    useAthanLabVoices: () => query(athan.voices, athan.voicesError),
    useAthanLabUsage: () => query(undefined, null),
    useSaveAthanLabKey: () =>
      useMutation({ mutationFn: (apiKey: string) => athan.saveKey(apiKey), gcTime: 0 }),
    useRemoveAthanLabKey: () => useMutation({ mutationFn: () => athan.removeKey() }),
  };
});

const { default: AthanLabPanel } = await import("./AthanLabPanel");

const CONNECTED: AthanLabKeyStatus = { connected: true, hint: "…k3y9", updatedAt: 1 };
const VOICES: AthanLabVoiceList = {
  voices: [
    { id: "thiri", name: "Thiri", category: "narration", source: "athanlab", isDefault: true },
  ],
  defaultVoiceId: "thiri",
};

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AthanLabPanel
        userId="user-1"
        capabilityAvailable
        capabilitiesLoading={false}
        disabled={false}
        onVoiceChange={() => {}}
        onReadyChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

const keyInput = () => screen.getByLabelText("AthanLab API key");
const changeButton = () => screen.getByRole("button", { name: "Change" });

function openKeyForm(): HTMLElement {
  const change = changeButton();
  change.focus();
  fireEvent.click(change);
  return keyInput();
}

describe("AthanLabPanel key form focus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    athan.keyStatus = CONNECTED;
    athan.keyError = null;
    athan.voices = VOICES;
    athan.voicesError = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves focus into the key field opened by Change, and back to Change on Cancel", () => {
    renderPanel();

    expect(openKeyForm()).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(changeButton()).toHaveFocus();
  });

  it("does not take focus on first connect", () => {
    athan.keyStatus = { connected: false };
    renderPanel();

    expect(keyInput()).not.toHaveFocus();
  });

  it("keeps focus on the key field while checking, then announces the rejection and ties it to the field", async () => {
    const save = deferred<unknown>();
    athan.saveKey.mockReturnValue(save.promise);
    renderPanel();
    const input = openKeyForm();

    fireEvent.change(input, { target: { value: "ak_live_wrong" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("status")
          .some((region) => region.textContent === "Checking your AthanLab key…"),
      ).toBe(true),
    );
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveFocus();

    save.reject(new Error("AthanLab rejected this key."));

    expect(await screen.findByRole("alert")).toHaveTextContent("AthanLab rejected this key.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("AthanLab rejected this key.");
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute("readonly");
  });

  it("returns focus to the key field when a save started from the Save button fails", async () => {
    athan.keyStatus = { connected: false };
    athan.saveKey.mockRejectedValue(new Error("This key is missing the speech:write scope."));
    renderPanel();

    fireEvent.change(keyInput(), { target: { value: "ak_live_scoped" } });
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    fireEvent.click(save);

    await screen.findByRole("alert");
    expect(keyInput()).toHaveFocus();
  });

  it("returns focus to Change after a replacement key is saved", async () => {
    athan.saveKey.mockResolvedValue({ hint: "…n3w1", updatedAt: 2 });
    renderPanel();
    const input = openKeyForm();

    fireEvent.change(input, { target: { value: "ak_live_new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(changeButton()).toHaveFocus());
    expect(screen.queryByLabelText("AthanLab API key")).toBeNull();
  });
});

describe("AthanLabPanel errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    athan.keyStatus = CONNECTED;
    athan.keyError = null;
    athan.voices = VOICES;
    athan.voicesError = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("announces a key status that could not be loaded", () => {
    athan.keyStatus = undefined;
    athan.keyError = new Error("Could not reach the AthanLab key service.");
    renderPanel();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not reach the AthanLab key service.",
    );
  });

  it("announces a voice list that could not be loaded", () => {
    athan.voices = undefined;
    athan.voicesError = new Error("AthanLab did not answer the voice list.");
    renderPanel();

    expect(screen.getByRole("alert")).toHaveTextContent("AthanLab did not answer the voice list.");
  });

  it("announces a failed disconnect", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    athan.removeKey.mockRejectedValue(new Error("Could not delete the saved key."));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not delete the saved key.");
  });

  it("announces a voice sample that could not play", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("blocked"));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Listen" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not play this voice's sample — try again.",
    );
  });
});
