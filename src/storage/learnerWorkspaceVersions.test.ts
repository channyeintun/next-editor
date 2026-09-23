// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeIndexedDB } from "../test/fakeIndexedDB";
import type { WorkspaceRecordingSnapshot } from "../types/workspace";
import {
  deleteLearnerWorkspaceVersion,
  listLearnerWorkspaceVersions,
  MAX_LEARNER_VERSIONS_PER_RECORDING,
  resetLearnerWorkspaceVersionsForTests,
  saveLearnerWorkspaceVersion,
} from "./learnerWorkspaceVersions";
import {
  getLearnerVersionsStore,
  keepLearnerWorkspace,
  openLearnerVersions,
  resetLearnerVersionsStoreForTests,
} from "../stores/learnerVersionsStore";

function workspace(content: string, activeFilePath = "index.html"): WorkspaceRecordingSnapshot {
  return {
    activeFilePath,
    collapsedFolders: [],
    project: {
      id: "project-1",
      name: "Lesson",
      lessonType: "html-css",
      entryFilePath: "index.html",
      folders: [],
      files: {
        "index.html": { path: "index.html", name: "index.html", language: "html", content },
      },
    },
  };
}

const save = (content: string, recordingTime = 1_000, recordingId = "lesson-a") => ({
  recordingId,
  recordingTime,
  snapshot: workspace(content),
});

describe("learner workspace versions", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new FakeIndexedDB().indexedDB);
  });

  afterEach(() => {
    resetLearnerWorkspaceVersionsForTests();
    resetLearnerVersionsStoreForTests();
    vi.unstubAllGlobals();
  });

  it("keeps each lesson's versions apart, newest first", async () => {
    await saveLearnerWorkspaceVersion(save("first"), 1);
    await saveLearnerWorkspaceVersion(save("other lesson", 0, "lesson-b"), 2);
    await saveLearnerWorkspaceVersion(save("second", 2_000), 3);

    const versions = await listLearnerWorkspaceVersions("lesson-a");

    expect(versions.map((version) => version.snapshot.project.files["index.html"].content)).toEqual(
      ["second", "first"],
    );
    expect(versions[0]).toMatchObject({
      recordingId: "lesson-a",
      recordingTime: 2_000,
      savedAt: 3,
    });
  });

  it("refreshes the newest version instead of copying unchanged files", async () => {
    const [first] = await saveLearnerWorkspaceVersion(save("same", 1_000), 1);
    // Restored and resumed with the same files, only another file open.
    const versions = await saveLearnerWorkspaceVersion(
      { recordingId: "lesson-a", recordingTime: 4_000, snapshot: workspace("same", "b.html") },
      2,
    );

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ id: first.id, recordingTime: 4_000, savedAt: 2 });
  });

  it("drops the oldest version past the cap", async () => {
    for (let index = 0; index <= MAX_LEARNER_VERSIONS_PER_RECORDING; index++) {
      await saveLearnerWorkspaceVersion(save(`v${index}`), index);
    }

    const versions = await listLearnerWorkspaceVersions("lesson-a");

    expect(versions).toHaveLength(MAX_LEARNER_VERSIONS_PER_RECORDING);
    expect(versions.at(-1)?.snapshot.project.files["index.html"].content).toBe("v1");
  });

  it("deletes a version", async () => {
    const [version] = await saveLearnerWorkspaceVersion(save("gone"), 1);

    await deleteLearnerWorkspaceVersion(version.id);

    expect(await listLearnerWorkspaceVersions("lesson-a")).toEqual([]);
  });

  it("mirrors the open lesson in the store and ignores saves for another", async () => {
    await saveLearnerWorkspaceVersion(save("earlier"), 1);
    await openLearnerVersions("lesson-a");
    const store = getLearnerVersionsStore();
    expect(store.getSnapshot().context.versions).toHaveLength(1);

    await keepLearnerWorkspace(save("now"));
    await keepLearnerWorkspace(save("elsewhere", 0, "lesson-b"));

    const { context } = store.getSnapshot();
    expect(context.recordingId).toBe("lesson-a");
    expect(context.versions.map((v) => v.snapshot.project.files["index.html"].content)).toEqual([
      "now",
      "earlier",
    ]);
    expect(context.lastSavedAt).not.toBeNull();
  });
});
