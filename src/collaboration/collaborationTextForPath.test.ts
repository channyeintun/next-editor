import { describe, expect, it } from "vite-plus/test";
import * as Y from "yjs";
import { collaborationTextForPath } from "./collaborationTextForPath";
import { getCollaborationTexts } from "./projectDocument";

const FILE_ID = "10000000-0000-4000-8000-000000000001";

function roomWithFile(path: string, fileNodeId: string) {
  return {
    getNodeIdForPath: (candidate: string) => (candidate === path ? fileNodeId : null),
  };
}

describe("collaborationTextForPath", () => {
  it("finds the shared text of the room file at a path", () => {
    const doc = new Y.Doc();
    const text = new Y.Text("hello");
    getCollaborationTexts(doc).set(FILE_ID, text);

    expect(
      collaborationTextForPath(roomWithFile("src/index.ts", FILE_ID), doc, "src/index.ts"),
    ).toBe(text);
  });

  it("has no text for a path the room does not know", () => {
    const doc = new Y.Doc();
    getCollaborationTexts(doc).set(FILE_ID, new Y.Text("hello"));

    expect(
      collaborationTextForPath(roomWithFile("src/index.ts", FILE_ID), doc, "src/other.ts"),
    ).toBeUndefined();
  });

  it("has no text for a file node without one", () => {
    const doc = new Y.Doc();

    expect(
      collaborationTextForPath(roomWithFile("src/index.ts", FILE_ID), doc, "src/index.ts"),
    ).toBeUndefined();
  });

  it("treats a room that cannot resolve paths yet as having no text", () => {
    const room = {
      getNodeIdForPath(): string | null {
        throw new Error("The project document has not been projected yet.");
      },
    };

    expect(collaborationTextForPath(room, new Y.Doc(), "src/index.ts")).toBeUndefined();
  });
});
