import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cursorDispatchTarget } from "./driver";

vi.mock("../monaco", () => ({
  monaco: {},
  workspacePathFromMonacoModelUri: vi.fn<() => string | null>(),
}));

function mountStudioPage() {
  // The editor root carries the cursor-replay root id; the studio console is
  // a fixed sibling outside it, as Editor's `overlay` renders it.
  const app = document.createElement("div");
  app.setAttribute("data-cursor-replay-target", "app");
  const runButton = document.createElement("button");
  app.append(runButton);
  const consolePanel = document.createElement("div");
  const consoleText = document.createElement("p");
  consolePanel.append(consoleText);
  document.body.append(app, consolePanel);
  return { app, runButton, consoleText };
}

describe("cursorDispatchTarget", () => {
  afterEach(() => {
    document.body.replaceChildren();
    // Drop the per-test hit-test stub (jsdom does no layout of its own).
    Reflect.deleteProperty(document, "elementsFromPoint");
  });

  it("dispatches on the element inside the app root under a covering console panel", () => {
    const { runButton, consoleText } = mountStudioPage();
    const fallback = document.createElement("span");
    document.elementsFromPoint = () => [consoleText, consoleText.parentElement!, runButton];

    expect(cursorDispatchTarget(900, 120, fallback)).toBe(runButton);
  });

  it("keeps the topmost hit when nothing covers the app", () => {
    const { app, runButton } = mountStudioPage();
    document.elementsFromPoint = () => [runButton, app, document.body];

    expect(cursorDispatchTarget(10, 10, document.body)).toBe(runButton);
  });

  it("falls back to the action target when the point hits nothing in the app", () => {
    const { runButton, consoleText } = mountStudioPage();
    document.elementsFromPoint = () => [consoleText];

    expect(cursorDispatchTarget(-5, -5, runButton)).toBe(runButton);
  });
});
