import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWorkspaceFile } from "../types/workspaceFiles";
import { useOpenWorkspaceFile } from "./useOpenWorkspaceFile";

// Every call the hook makes, in order, across the three owners it calls.
const state = vi.hoisted(() => ({
  calls: [] as string[],
  activeFilePath: "src/a.ts",
  files: new Set(["src/a.ts", "src/b.ts"]),
  collaboration: null as { stopFollowing: (reason: string) => void } | null,
}));

vi.mock("./useWorkspace", () => ({
  useWorkspaceActions: () => ({
    getActiveFilePath: () => state.activeFilePath,
    getFile: (path: string) => (state.files.has(path) ? createWorkspaceFile(path, "") : null),
    setActiveFilePath: (path: string) => state.calls.push(`setActiveFilePath:${path}`),
  }),
}));
vi.mock("./useNextEditorContext", () => ({
  useNextEditorActions: () => ({
    pause: () => state.calls.push("pause"),
    handleWorkspaceEvent: () => state.calls.push("handleWorkspaceEvent"),
  }),
}));
vi.mock("../contexts/CollaborationContext", () => ({
  useOptionalCollaboration: () => state.collaboration,
}));

beforeEach(() => {
  state.calls = [];
  state.collaboration = {
    stopFollowing: (reason: string) => state.calls.push(`stopFollowing:${reason}`),
  };
});

function open(path: string) {
  const { result } = renderHook(() => useOpenWorkspaceFile());
  result.current(path);
  return state.calls;
}

describe("useOpenWorkspaceFile", () => {
  it("ends a follow, pauses, switches, then records the switch, in that order", () => {
    expect(open("src/b.ts")).toEqual([
      "stopFollowing:local-file-navigation",
      "pause",
      "setActiveFilePath:src/b.ts",
      "handleWorkspaceEvent",
    ]);
  });

  it("normalizes the path before it looks the file up", () => {
    expect(open("./src/b.ts")).toContain("setActiveFilePath:src/b.ts");
  });

  it.each([
    ["the file that is already open", "src/a.ts"],
    ["a file the workspace does not have", "src/missing.ts"],
    ["an empty path", ""],
  ])("only ends the follow for %s", (_, path) => {
    expect(open(path)).toEqual(["stopFollowing:local-file-navigation"]);
  });

  it("works outside a collaboration room", () => {
    state.collaboration = null;
    expect(open("src/b.ts")).toEqual([
      "pause",
      "setActiveFilePath:src/b.ts",
      "handleWorkspaceEvent",
    ]);
  });
});
