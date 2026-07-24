import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  STUDIO_TARGET_ATTRIBUTE,
  resolveStudioTarget,
  studioTargetIdForFile,
  STUDIO_RUN_BUTTON_TARGET_ID,
} from "./targets";

function mountTarget(id: string): Element {
  const element = document.createElement("div");
  element.setAttribute(STUDIO_TARGET_ATTRIBUTE, id);
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("resolveStudioTarget", () => {
  it("finds a file row by its workspace path", () => {
    const element = mountTarget(studioTargetIdForFile("src/main.rs"));
    expect(resolveStudioTarget({ kind: "file", path: "src/main.rs" })).toBe(element);
  });

  it("finds the run button", () => {
    const element = mountTarget(STUDIO_RUN_BUTTON_TARGET_ID);
    expect(resolveStudioTarget({ kind: "run-button" })).toBe(element);
  });

  // The id lands inside a quoted attribute selector, so a quote or backslash in
  // the path has to be escaped for a CSS *string*. Pins the behaviour for the
  // characters that would otherwise terminate the selector early.
  it("resolves paths containing a quote or a backslash", () => {
    const quoted = mountTarget(studioTargetIdForFile('src/say "hi".rs'));
    const escaped = mountTarget(studioTargetIdForFile("src/back\\slash.rs"));

    expect(resolveStudioTarget({ kind: "file", path: 'src/say "hi".rs' })).toBe(quoted);
    expect(resolveStudioTarget({ kind: "file", path: "src/back\\slash.rs" })).toBe(escaped);
  });

  it("returns null for a target that is not mounted", () => {
    expect(resolveStudioTarget({ kind: "target-id", id: "absent" })).toBeNull();
  });
});
