import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { FakeIndexedDB } from "@app/test/fakeIndexedDB";
import {
  clearResumeIntent,
  loadResumeIntent,
  saveResumeIntent,
  type ResumeIntent,
} from "./resumeIntent";

const intent: ResumeIntent = { recordingId: "take-1", returnTo: "/code" };

describe("resume intent store", () => {
  let fake: FakeIndexedDB;

  beforeEach(() => {
    fake = new FakeIndexedDB();
    vi.stubGlobal("indexedDB", fake.indexedDB);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves, loads and clears the pointer", async () => {
    await saveResumeIntent(intent);
    await expect(loadResumeIntent()).resolves.toEqual(intent);

    await clearResumeIntent();
    await expect(loadResumeIntent()).resolves.toBeNull();
  });

  // Right after the take's own save, the pointer's commit is the write most likely to
  // run over quota. It aborts without an error event; the caller must still hear of it,
  // or the upload modal neither redirects nor shows its error.
  it("rejects when the save aborts at commit", async () => {
    const quota = new DOMException("The quota has been exceeded", "QuotaExceededError");
    fake.failNextCommit(quota);

    await expect(saveResumeIntent(intent)).rejects.toBe(quota);
  });

  it("rejects when the clear aborts at commit", async () => {
    await saveResumeIntent(intent);
    const quota = new DOMException("The quota has been exceeded", "QuotaExceededError");
    fake.failNextCommit(quota);

    await expect(clearResumeIntent()).rejects.toBe(quota);
  });
});
