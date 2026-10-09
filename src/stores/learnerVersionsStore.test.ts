import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  deleteLearnerWorkspaceVersion,
  LearnerWorkspaceVersion,
  listLearnerWorkspaceVersions,
  saveLearnerWorkspaceVersion,
} from "../storage/learnerWorkspaceVersions";
import type { WorkspaceRecordingSnapshot } from "../types/workspace";
import {
  forgetLearnerVersion,
  getLearnerVersionsStore,
  openLearnerVersions,
  resetLearnerVersionsStoreForTests,
} from "./learnerVersionsStore";

const storage = vi.hoisted(() => ({
  listLearnerWorkspaceVersions: vi.fn<typeof listLearnerWorkspaceVersions>(),
  deleteLearnerWorkspaceVersion: vi.fn<typeof deleteLearnerWorkspaceVersion>(),
  saveLearnerWorkspaceVersion: vi.fn<typeof saveLearnerWorkspaceVersion>(),
}));

vi.mock("../storage/learnerWorkspaceVersions", () => storage);

const version = (id: string, recordingTime: number): LearnerWorkspaceVersion => ({
  id,
  recordingId: "lesson",
  recordingTime,
  savedAt: recordingTime,
  snapshot: {} as WorkspaceRecordingSnapshot,
});
const SAVED = [version("late", 65_000), version("early", 5_000)];
const versionIds = () =>
  getLearnerVersionsStore()
    .getSnapshot()
    .context.versions.map((v) => v.id);

beforeEach(async () => {
  resetLearnerVersionsStoreForTests();
  storage.listLearnerWorkspaceVersions.mockResolvedValue(SAVED);
  await openLearnerVersions("lesson");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("forgetLearnerVersion", () => {
  it("drops a deleted version from the menu at once", async () => {
    storage.deleteLearnerWorkspaceVersion.mockResolvedValue();

    const forgotten = forgetLearnerVersion("late");
    expect(versionIds()).toEqual(["early"]);
    await forgotten;

    expect(storage.deleteLearnerWorkspaceVersion).toHaveBeenCalledWith("late");
    expect(versionIds()).toEqual(["early"]);
  });

  it("shows a version again when deleting it fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    storage.deleteLearnerWorkspaceVersion.mockRejectedValue(new Error("blocked"));

    await forgetLearnerVersion("late");

    expect(warn).toHaveBeenCalled();
    expect(versionIds()).toEqual(["late", "early"]);
  });
});
