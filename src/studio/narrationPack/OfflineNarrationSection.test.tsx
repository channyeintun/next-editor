import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NarrationAudioImport } from "./audioImport";
import { COLAB_NOTEBOOK_URL } from "./colabNotebook";
import type { NarrationCoverage } from "./coverage";
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

/** Coverage of lessons given as [slug, dialogs, dialogs missing]. */
function coverageOf(lessons: [string, number, number][]): NarrationCoverage {
  const missing = lessons.reduce((sum, [, , missingCount]) => sum + missingCount, 0);
  return {
    lessons: lessons.map(([slug, dialogCount, missingCount]) => ({
      slug,
      dialogCount,
      missingCount,
    })),
    missingDialogCount: missing,
    missingCharacterCount: missing * 100,
    cacheUnavailable: null,
  };
}

function apiOf(overrides: Partial<OfflineNarrationApi> = {}): OfflineNarrationApi {
  return {
    exportBlockedReason: null,
    coverageOf: vi.fn<OfflineNarrationApi["coverageOf"]>(async (slugs) =>
      coverageOf(slugs.map((slug) => [slug, 40, 0])),
    ),
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
const coverageLine = () => screen.getByTestId("studio-offline-narration-coverage");

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
    expect(coverageLine()).toBeEmptyDOMElement();
  });

  it("says which picked lessons a render would still buy narration for, and narrows to the rest", async () => {
    const api = apiOf({
      coverageOf: vi.fn<OfflineNarrationApi["coverageOf"]>(async (slugs) =>
        coverageOf(slugs.map((slug) => [slug, 40, slug === "maps" ? 40 : 0])),
      ),
    });
    const onPickOnly = vi.fn<(slugs: readonly string[]) => void>();
    const { rerender } = render(
      <OfflineNarrationSection
        api={api}
        slugs={["intro", "loops", "maps"]}
        onPickOnly={onPickOnly}
      />,
    );

    expect(screen.getByText(/Counting the picked lessons/)).toBeInTheDocument();
    await waitFor(() =>
      expect(coverageLine()).toHaveTextContent(
        "2 of the 3 picked lessons have all their narration in this browser. The other one lacks 40 dialogs (4,000 characters), which a render asks the speech service for: maps lacks all 40 of its dialogs.",
      ),
    );
    expect(api.coverageOf).toHaveBeenCalledExactlyOnceWith(
      ["intro", "loops", "maps"],
      expect.any(AbortSignal),
    );
    expect(screen.queryByText(/Counting the picked lessons/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Pick only the 2 lessons with all their narration" }),
    );
    expect(onPickOnly).toHaveBeenCalledExactlyOnceWith(["intro", "loops"]);
    // The button goes once the selection is narrowed: focus must not go with it.
    expect(coverageLine()).toHaveFocus();

    // The count is for the selection it was made for: a changed one is counted again.
    rerender(
      <OfflineNarrationSection api={api} slugs={["intro", "loops"]} onPickOnly={onPickOnly} />,
    );
    expect(coverageLine()).toBeEmptyDOMElement();
    await waitFor(() =>
      expect(coverageLine()).toHaveTextContent(
        "All 2 picked lessons have their narration in this browser: a render asks no speech service for it.",
      ),
    );
    expect(screen.queryByRole("button", { name: /^Pick only/ })).not.toBeInTheDocument();
  });

  it("counts one selection once, however often it is drawn again", async () => {
    const api = apiOf();
    const { rerender } = render(<OfflineNarrationSection api={api} slugs={["intro"]} />);
    // The console hands over a new api object and a new list on every render.
    rerender(<OfflineNarrationSection api={{ ...api }} slugs={["intro"]} />);
    rerender(<OfflineNarrationSection api={{ ...api }} slugs={["intro"]} />);

    await waitFor(() => expect(coverageLine()).toHaveTextContent("The picked lesson has all"));
    expect(api.coverageOf).toHaveBeenCalledTimes(1);
  });

  it("does not count while the narrator is not set, and says why a count failed", async () => {
    const blocked = apiOf({ exportBlockedReason: "Choose a narrator reference first." });
    const { rerender } = render(<OfflineNarrationSection api={blocked} slugs={["intro"]} />);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(blocked.coverageOf).not.toHaveBeenCalled();
    expect(coverageLine()).toBeEmptyDOMElement();

    const failing = apiOf({
      coverageOf: vi.fn<OfflineNarrationApi["coverageOf"]>(async () => {
        throw new Error("intro: no narration profile");
      }),
    });
    rerender(<OfflineNarrationSection api={failing} slugs={["intro"]} />);
    await waitFor(() =>
      expect(coverageLine()).toHaveTextContent(
        "Could not tell which picked lessons have narration in this browser (intro: no narration profile).",
      ),
    );
  });

  it("counts again once an import has ended, and not while it runs", async () => {
    let finish: (value: NarrationAudioImport) => void = () => {};
    let missing = 40;
    const api = apiOf({
      coverageOf: vi.fn<OfflineNarrationApi["coverageOf"]>(async (slugs) =>
        coverageOf(slugs.map((slug) => [slug, 40, missing])),
      ),
      importAudio: vi.fn<OfflineNarrationApi["importAudio"]>(
        () => new Promise<NarrationAudioImport>((resolve) => (finish = resolve)),
      ),
    });
    const { container } = render(<OfflineNarrationSection api={api} slugs={["intro"]} />);
    await waitFor(() => expect(coverageLine()).toHaveTextContent("None of the narration"));

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["zip"], "audio-0001.zip")] } });
    await waitFor(() => expect(importButton()).toBeDisabled());
    // A count made now would be of a cache that is still filling.
    expect(coverageLine()).toBeEmptyDOMElement();

    missing = 0;
    finish({ imported: 40, alreadyCached: 0, ignored: 0, unusable: [], storageFailure: null });
    await waitFor(() =>
      expect(coverageLine()).toHaveTextContent("The picked lesson has all its narration"),
    );
    expect(api.coverageOf).toHaveBeenCalledTimes(2);
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
