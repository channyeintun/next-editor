import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NarrationAudioImport } from "./audioImport";
import type { NarrationCoverage } from "./coverage";
import {
  coverageReportOf,
  exportNarrationRequests,
  exportStatusOf,
  importNarrationFiles,
  importStatusOf,
  offlineNarrationStore,
  selectNarrationImportRunning,
  type OfflineNarrationApi,
} from "./offlineNarration";
import type { NarrationRequestPack, NarrationRequestPackExport } from "./requestPack";

const download = vi.hoisted(() => ({ downloadBlob: vi.fn<(blob: Blob, name: string) => void>() }));
vi.mock("../../utils/downloadBlob", () => download);

const context = () => offlineNarrationStore.getSnapshot().context;

const pack = {
  createdAt: "2026-11-14T03:40:42.000Z",
  dialogs: [],
} as unknown as NarrationRequestPack;

function exported(overrides: Partial<NarrationRequestPackExport> = {}): NarrationRequestPackExport {
  return {
    pack,
    lessonCount: 2,
    dialogCount: 1234,
    characterCount: 56_789,
    cachedCount: 0,
    cacheUnavailable: null,
    ...overrides,
  };
}

function imported(overrides: Partial<NarrationAudioImport> = {}): NarrationAudioImport {
  return {
    imported: 0,
    alreadyCached: 0,
    ignored: 0,
    unusable: [],
    storageFailure: null,
    ...overrides,
  };
}

function apiOf(overrides: Partial<OfflineNarrationApi> = {}): OfflineNarrationApi {
  return {
    exportBlockedReason: null,
    exportRequests: vi.fn<OfflineNarrationApi["exportRequests"]>(async () => exported()),
    importAudio: vi.fn<OfflineNarrationApi["importAudio"]>(async () => imported({ imported: 3 })),
    coverageOf: vi.fn<OfflineNarrationApi["coverageOf"]>(async () => coverage([])),
    ...overrides,
  };
}

/** Coverage of lessons given as [slug, dialogs, dialogs missing], 100 characters a missing dialog. */
function coverage(
  lessons: [string, number, number][],
  overrides: Partial<NarrationCoverage> = {},
): NarrationCoverage {
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
    ...overrides,
  };
}

beforeEach(() => {
  offlineNarrationStore.trigger.reset();
  download.downloadBlob.mockReset();
});

describe("exportNarrationRequests", () => {
  it("downloads the pack and says what is in it, for the lessons it was asked for", async () => {
    const api = apiOf();

    await exportNarrationRequests(api, ["intro", "loops"]);

    expect(api.exportRequests).toHaveBeenCalledExactlyOnceWith(["intro", "loops"]);
    expect(download.downloadBlob).toHaveBeenCalledOnce();
    const [blob, name] = download.downloadBlob.mock.calls[0];
    expect(name).toBe("narration-requests-2026-11-14.json");
    expect(JSON.parse(await blob.text())).toEqual(pack);
    expect(context()).toEqual({
      busy: null,
      importedTakes: 0,
      // An export changes nothing about the takes this browser keeps.
      importsEnded: 0,
      status: {
        tone: "ok",
        text: "Exported 1,234 dialogs of 2 lessons (56,789 characters).",
        forSlugs: "intro\nloops",
      },
    });
  });

  it("is busy, and says so, until the export ends", async () => {
    let finish: (value: NarrationRequestPackExport) => void = () => {};
    const api = apiOf({
      exportRequests: () =>
        new Promise<NarrationRequestPackExport>((resolve) => (finish = resolve)),
    });

    const running = exportNarrationRequests(api, ["intro"]);

    expect(context()).toMatchObject({
      busy: "export",
      status: { text: "Exporting the requests…" },
    });
    expect(selectNarrationImportRunning(context())).toBe(false);
    finish(exported({ pack: null, dialogCount: 0, cachedCount: 40 }));
    await running;
    expect(download.downloadBlob).not.toHaveBeenCalled();
    expect(context().status?.text).toBe(
      "Nothing to export: this browser already keeps all 40 dialogs of these lessons.",
    );
  });

  it("reports why an export failed", async () => {
    const api = apiOf({
      exportRequests: async () => {
        throw new Error('go-swap: Burmese narration requires a LessonScript locale of "my"');
      },
    });

    await exportNarrationRequests(api, ["go-swap"]);

    expect(context()).toMatchObject({
      busy: null,
      status: { tone: "error", text: expect.stringContaining("go-swap:"), forSlugs: "go-swap" },
    });
  });
});

describe("importNarrationFiles", () => {
  const files = [new File(["zip"], "audio-0001.zip")];

  it("counts takes as they are filed and ends with the result", async () => {
    let finish: (value: NarrationAudioImport) => void = () => {};
    const api = apiOf({
      importAudio: vi.fn<OfflineNarrationApi["importAudio"]>((_files, onProgress) => {
        onProgress(1);
        onProgress(2);
        return new Promise<NarrationAudioImport>((resolve) => (finish = resolve));
      }),
    });

    const running = importNarrationFiles(api, files);

    expect(context()).toMatchObject({
      busy: "import",
      importedTakes: 2,
      importsEnded: 0,
      status: { text: "Importing the audio…" },
    });
    // A render started now would buy the takes the import has not reached.
    expect(selectNarrationImportRunning(context())).toBe(true);
    // One import at a time: a second one is not started.
    await importNarrationFiles(api, files);
    expect(api.importAudio).toHaveBeenCalledOnce();

    finish(imported({ imported: 2, alreadyCached: 1 }));
    await running;
    expect(selectNarrationImportRunning(context())).toBe(false);
    // What the browser keeps has changed: a count of it made before is stale.
    expect(context().importsEnded).toBe(1);
    expect(context().status).toEqual({
      tone: "ok",
      text: "Imported 2 takes. 1 take was already in this browser.",
    });
  });

  it("does nothing for an empty choice of files", async () => {
    const api = apiOf();
    await importNarrationFiles(api, []);
    expect(api.importAudio).not.toHaveBeenCalled();
    expect(context().status).toBeNull();
  });

  it("reports an import that threw", async () => {
    const api = apiOf({
      importAudio: async () => {
        throw new Error("out of memory");
      },
    });
    await importNarrationFiles(api, files);
    expect(context()).toMatchObject({
      busy: null,
      status: { tone: "error", text: "out of memory" },
    });
  });
});

describe("what the picked lessons' coverage reports", () => {
  it("has nothing to say for no lessons", () => {
    expect(coverageReportOf(coverage([]))).toBeNull();
  });

  it("says when a render needs no speech service", () => {
    expect(coverageReportOf(coverage([["intro", 40, 0]]))).toEqual({
      status: {
        tone: "ok",
        text: "The picked lesson has all its narration in this browser: a render asks no speech service for it.",
      },
      completeOnly: null,
    });
    expect(
      coverageReportOf(
        coverage([
          ["intro", 40, 0],
          ["loops", 38, 0],
        ]),
      )?.status.text,
    ).toBe(
      "All 2 picked lessons have their narration in this browser: a render asks no speech service for it.",
    );
  });

  it("says what a render buys when nothing is here yet, without alarm", () => {
    expect(
      coverageReportOf(
        coverage([
          ["intro", 700, 700],
          ["loops", 807, 807],
        ]),
      ),
    ).toEqual({
      status: {
        tone: "ok",
        text: "None of the narration of the 2 picked lessons is in this browser yet: a render asks the speech service for all of it, 1,507 dialogs (150,700 characters).",
      },
      completeOnly: null,
    });
    expect(coverageReportOf(coverage([["intro", 1, 1]]))?.status.text).toBe(
      "None of the narration of the picked lesson is in this browser yet: a render asks the speech service for all of it, 1 dialog (100 characters).",
    );
  });

  it("warns when only some picked lessons are narrated here, naming the first that are not", () => {
    expect(
      coverageReportOf(
        coverage([
          ["architect-19", 36, 0],
          ["architect-20", 39, 2],
          ["architect-21", 34, 34],
          ["architect-22", 43, 43],
          ["architect-23", 37, 37],
          ["architect-24", 38, 38],
        ]),
      ),
    ).toEqual({
      status: {
        tone: "warning",
        text: "1 of the 6 picked lessons has all its narration in this browser. The other 5 lack 154 dialogs (15,400 characters), which a render asks the speech service for: architect-20 lacks 2 of its 39 dialogs, architect-21 lacks all 34 of its dialogs, architect-22 lacks all 43 of its dialogs, and 2 more lessons.",
      },
      completeOnly: ["architect-19"],
    });
    expect(
      coverageReportOf(
        coverage([
          ["a", 10, 0],
          ["b", 10, 0],
          ["c", 10, 4],
        ]),
      ),
    ).toEqual({
      status: {
        tone: "warning",
        text: "2 of the 3 picked lessons have all their narration in this browser. The other one lacks 4 dialogs (400 characters), which a render asks the speech service for: c lacks 4 of its 10 dialogs.",
      },
      completeOnly: ["a", "b"],
    });
  });

  it("offers no narrower selection when no picked lesson is whole", () => {
    expect(
      coverageReportOf(
        coverage([
          ["a", 10, 3],
          ["b", 10, 10],
        ]),
      ),
    ).toEqual({
      status: {
        tone: "warning",
        text: "None of the 2 picked lessons have all their narration in this browser. They lack 13 dialogs (1,300 characters), which a render asks the speech service for: a lacks 3 of its 10 dialogs, b lacks all 10 of its dialogs.",
      },
      completeOnly: null,
    });
    expect(coverageReportOf(coverage([["a", 39, 2]]))?.status).toEqual({
      tone: "warning",
      text: "The picked lesson lacks 2 of its 39 dialogs in this browser: a render asks the speech service for those (200 characters).",
    });
    expect(coverageReportOf(coverage([["a", 39, 1]]))?.status.text).toBe(
      "The picked lesson lacks 1 of its 39 dialogs in this browser: a render asks the speech service for it (100 characters).",
    );
    // One lesson more than the report names, and a lesson of a single dialog.
    expect(
      coverageReportOf(
        coverage([
          ["a", 10, 0],
          ["b", 1, 1],
          ["c", 5, 5],
          ["d", 5, 1],
          ["e", 5, 5],
        ]),
      )?.status.text,
    ).toBe(
      "1 of the 5 picked lessons has all its narration in this browser. The other 4 lack 12 dialogs (1,200 characters), which a render asks the speech service for: b lacks its one dialog, c lacks all 5 of its dialogs, d lacks 1 of its 5 dialogs, and 1 more lesson.",
    );
  });

  it("says when the browser cannot keep narration at all", () => {
    expect(
      coverageReportOf(
        coverage([["a", 10, 10]], { cacheUnavailable: "Cache storage is not available" }),
      ),
    ).toEqual({
      status: {
        tone: "warning",
        text: "This browser cannot keep narration (Cache storage is not available): a render asks the speech service for every dialog of the picked lessons.",
      },
      completeOnly: null,
    });
  });
});

describe("what an export and an import report", () => {
  it("says what was left out of an export, and when the audio could not come back", () => {
    expect(exportStatusOf(exported({ dialogCount: 1, lessonCount: 1, cachedCount: 1 })).text).toBe(
      "Exported 1 dialog of 1 lesson (56,789 characters). 1 dialog already in this browser was left out.",
    );
    expect(exportStatusOf(exported({ pack: null, dialogCount: 0 })).text).toBe(
      "Nothing to export: these lessons have no narration.",
    );
    expect(
      exportStatusOf(exported({ cacheUnavailable: "Cache storage is not available" })),
    ).toEqual({
      tone: "warning",
      text: "Exported 1,234 dialogs, but this browser cannot keep narration (Cache storage is not available), so it will not be able to import the audio.",
    });
  });

  it("puts the first unusable file and a storage failure into the import's report", () => {
    expect(importStatusOf(imported())).toEqual({
      tone: "warning",
      text: "No narration takes were found in those files.",
    });
    expect(
      importStatusOf(
        imported({
          imported: 10,
          unusable: [
            { name: "a.flac", reason: "audio is silent" },
            { name: "b.flac", reason: "wrong rate" },
          ],
        }),
      ),
    ).toEqual({
      tone: "warning",
      text: "Imported 10 takes. 2 files could not be used (a.flac: audio is silent).",
    });
    expect(importStatusOf(imported({ imported: 4, storageFailure: "Quota exceeded." }))).toEqual({
      tone: "error",
      text: "Imported 4 takes. The browser keeps no more narration (Quota exceeded.); the rest was not imported.",
    });
  });
});
