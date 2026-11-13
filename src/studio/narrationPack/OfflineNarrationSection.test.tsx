import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NarrationAudioImport } from "./audioImport";
import { COLAB_NOTEBOOK_URL } from "./colabNotebook";
import { offlineNarrationStore, type OfflineNarrationApi } from "./offlineNarration";
import OfflineNarrationSection from "./OfflineNarrationSection";
import type { NarrationRequestPackExport } from "./requestPack";

vi.mock("../../utils/downloadBlob", () => ({ downloadBlob: vi.fn<() => void>() }));

const nothingToExport: NarrationRequestPackExport = {
  pack: null,
  lessonCount: 2,
  dialogCount: 0,
  characterCount: 0,
  cachedCount: 80,
  cacheUnavailable: null,
};

function apiOf(overrides: Partial<OfflineNarrationApi> = {}): OfflineNarrationApi {
  return {
    exportBlockedReason: null,
    exportRequests: vi.fn<OfflineNarrationApi["exportRequests"]>(async () => nothingToExport),
    importAudio: vi.fn<OfflineNarrationApi["importAudio"]>(async () => ({
      imported: 3,
      alreadyCached: 0,
      ignored: 0,
      unusable: [],
      storageFailure: null,
    })),
    ...overrides,
  };
}

const exportButton = () => screen.getByRole("button", { name: /^Export/ });
const importButton = () => screen.getByRole("button", { name: /^Import/ });

beforeEach(() => {
  offlineNarrationStore.trigger.reset();
});

afterEach(() => {
  cleanup();
});

describe("OfflineNarrationSection", () => {
  it("links the notebook and waits for lessons before it exports", () => {
    render(<OfflineNarrationSection api={apiOf()} slugs={[]} />);

    expect(screen.getByRole("link", { name: "the notebook" })).toHaveAttribute(
      "href",
      COLAB_NOTEBOOK_URL,
    );
    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveAccessibleDescription(/Pick the lessons above/);
    // Audio from an earlier export can come back with nothing picked.
    expect(importButton()).toBeEnabled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("says why it cannot export, and still imports", () => {
    render(
      <OfflineNarrationSection
        api={apiOf({ exportBlockedReason: "Choose a narrator reference in the Render tab first." })}
        slugs={["intro"]}
      />,
    );

    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveAccessibleDescription(
      "Choose a narrator reference in the Render tab first.",
    );
    expect(importButton()).toBeEnabled();
  });

  it("reports an export for the lessons it was asked for, and drops the report when they change", async () => {
    const api = apiOf();
    const { rerender } = render(<OfflineNarrationSection api={api} slugs={["intro", "loops"]} />);

    fireEvent.click(exportButton());

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Nothing to export: this browser already keeps all 80 dialogs of these lessons.",
      ),
    );
    expect(api.exportRequests).toHaveBeenCalledExactlyOnceWith(["intro", "loops"]);
    expect(exportButton()).toHaveTextContent("Export requests (2)");

    rerender(<OfflineNarrationSection api={api} slugs={["intro", "loops", "maps"]} />);

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(exportButton()).toHaveTextContent("Export requests (3)");
  });

  it("counts takes while it imports, and keeps the result when it is shown again", async () => {
    let finish: (value: NarrationAudioImport) => void = () => {};
    const api = apiOf({
      importAudio: vi.fn<OfflineNarrationApi["importAudio"]>((_files, onProgress) => {
        onProgress(1200);
        return new Promise<NarrationAudioImport>((resolve) => (finish = resolve));
      }),
    });
    const { container, unmount } = render(<OfflineNarrationSection api={api} slugs={[]} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["zip"], "audio-0001.zip");

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(importButton()).toHaveTextContent("Importing… 1,200"));
    expect(importButton()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Importing the audio…");
    expect(api.importAudio).toHaveBeenCalledExactlyOnceWith([file], expect.any(Function));

    // The Workflow tab's setup view goes away when a workflow starts; the import does not.
    unmount();
    finish({ imported: 2368, alreadyCached: 0, ignored: 1, unusable: [], storageFailure: null });
    render(<OfflineNarrationSection api={api} slugs={["intro"]} />);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Imported 2,368 takes."),
    );
    expect(importButton()).toBeEnabled();
  });
});
