import { describe, expect, it } from "vitest";

import {
  isWorkspaceLessonType,
  lessonRunsInWebContainer,
  WORKSPACE_LESSON_TYPE_LABELS,
  WORKSPACE_LESSON_TYPES,
  type WorkspaceLessonType,
} from "../types/workspace";
import { createStarterWorkspaceForLessonType } from "./index";

/**
 * A lesson type is only real if every layer knows about it: the starter
 * registry can build it, and the picker offers it.
 *
 * `kite` was runnable for a while and offered nowhere — the picker kept its
 * own hand-written array, so adding a lesson type compiled fine and simply
 * never appeared. The lists are derived from one `Record` now, and this holds
 * the remaining links that a type cannot express.
 */
describe("starter registry", () => {
  it("names every lesson type in the picker", () => {
    // The Record is keyed by the union, so this is really asserting the
    // derivation still happens rather than that someone updated a list.
    for (const lessonType of WORKSPACE_LESSON_TYPES) {
      expect(WORKSPACE_LESSON_TYPE_LABELS[lessonType], `${lessonType} has no label`).toBeTruthy();
    }
    expect(WORKSPACE_LESSON_TYPES).toContain("kite");
    expect(WORKSPACE_LESSON_TYPES).toContain("kite-web");
  });

  it("builds a workspace for every lesson type it offers", async () => {
    for (const lessonType of WORKSPACE_LESSON_TYPES) {
      const project = await createStarterWorkspaceForLessonType(lessonType);
      expect(project.lessonType, `${lessonType} builds a mismatched workspace`).toBe(lessonType);
      expect(Object.keys(project.files).length, `${lessonType} has no files`).toBeGreaterThan(0);
      expect(
        project.entryFilePath in project.files,
        `${lessonType} names an entry it does not contain`,
      ).toBe(true);
    }
  });

  it("gives every WebContainer starter a package.json to install", async () => {
    for (const lessonType of WORKSPACE_LESSON_TYPES.filter(lessonRunsInWebContainer)) {
      // Python is the exception: WASI python3 is built in and installs nothing.
      if (lessonType === "python") continue;
      const project = await createStarterWorkspaceForLessonType(lessonType);
      expect(project.files, `${lessonType} has no package.json`).toHaveProperty("package.json");
    }
  });

  it("accepts exactly the lesson types it knows", () => {
    for (const lessonType of WORKSPACE_LESSON_TYPES) {
      expect(isWorkspaceLessonType(lessonType)).toBe(true);
    }
    for (const notOne of ["", "kite-lang", "rust-web", 7, null, undefined]) {
      expect(isWorkspaceLessonType(notOne as WorkspaceLessonType)).toBe(false);
    }
  });
});
