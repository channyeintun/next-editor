import { describe, expect, it } from "vitest";
import { makeFile, makeStore, makeCtx } from "./testUtils";
import { getProject } from "./workspaceFs";
import { ABORTED_TOOL_OUTPUT, codingToolNamesFor, createCodingTools } from "./index";

type ExecutableTool = {
  function: { name: string; execute: (input: unknown) => unknown };
};

function toolsByName(tools: unknown[]): Map<string, ExecutableTool> {
  return new Map((tools as ExecutableTool[]).map((tool) => [tool.function.name, tool]));
}

// The SDK owns the tool loop, accepts no AbortSignal, and `cancel()` reaches only
// the first turn's stream — so after Stop it keeps invoking these `execute`
// closures. This guard is the only thing standing between a stopped run and the
// user's files, and none of those writes reach the transcript.
describe("coding tool abort guard", () => {
  it("refuses to mutate the workspace once the run is aborted", async () => {
    const controller = new AbortController();
    const store = makeStore([makeFile("a.txt", "original")]);
    const tools = toolsByName(createCodingTools(makeCtx(store, controller.signal), "webcontainer"));

    controller.abort();

    expect(
      await tools.get("write")?.function.execute({ path: "a.txt", content: "clobbered" }),
    ).toBe(ABORTED_TOOL_OUTPUT);
    expect(
      await tools.get("edit")?.function.execute({
        path: "a.txt",
        edits: [{ oldText: "original", newText: "clobbered" }],
      }),
    ).toBe(ABORTED_TOOL_OUTPUT);

    expect(getProject(store)?.files["a.txt"]?.content).toBe("original");
  });

  it("guards every tool in the profile, not just the mutating ones", async () => {
    const controller = new AbortController();
    const store = makeStore([makeFile("a.txt", "original")]);
    const tools = toolsByName(createCodingTools(makeCtx(store, controller.signal), "webcontainer"));

    controller.abort();

    for (const name of codingToolNamesFor("webcontainer")) {
      expect(await tools.get(name)?.function.execute({})).toBe(ABORTED_TOOL_OUTPUT);
    }
  });

  it("leaves tools working while the run is live", async () => {
    const store = makeStore([makeFile("a.txt", "original")]);
    const tools = toolsByName(createCodingTools(makeCtx(store), "webcontainer"));

    expect(
      await tools.get("write")?.function.execute({ path: "a.txt", content: "updated" }),
    ).toContain("Updated a.txt");
    expect(getProject(store)?.files["a.txt"]?.content).toBe("updated");
  });
});
