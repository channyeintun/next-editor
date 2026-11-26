// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";

import { pickPythonRunEntry } from "../runtime/pythonPlayground/client";
import { pythonRunResultToConsoleLines } from "../runtime/pythonPlayground/console";
import { collectPythonPlaygroundFiles } from "../runtime/pythonPlayground/files";
import { bootPythonInterpreter } from "../runtime/pythonPlayground/interpreter";
import { isWorkspaceTextFile } from "../types/workspace";
import { createStarterPythonWorkspace } from "./python";

/**
 * The Python starter runs, and prints what its README says it prints.
 *
 * Pressing Run is the first thing a learner does with a starter, and the Kite
 * one once answered that with a build error. This takes the steps the dock
 * takes — collect the workspace's files, pick the script, run it, render the
 * result — on the real interpreter, which runs under Node as it does in the
 * page's worker. It asks the interpreter and not the client, which would start
 * a second interpreter for a next run that never comes.
 */
describe("python starter program", () => {
  it("prints the output its README shows", async () => {
    const project = createStarterPythonWorkspace();
    const files = collectPythonPlaygroundFiles(project);

    const python = await bootPythonInterpreter();
    const result = await python.run(files, pickPythonRunEntry(files).path);

    expect(result.status).toBe("success");
    const readme = project.files["README.md"];
    const shown = /```\n([\s\S]*?)```/.exec(isWorkspaceTextFile(readme) ? readme.content : "");
    expect(shown).not.toBeNull();
    const promised = shown![1].split("\n").map((line) => line.replace(/^ {3}/, ""));
    expect(result.output.split("\n")).toEqual(promised);
    expect(pythonRunResultToConsoleLines(result).at(-1)).toBe("[python-run] Program exited");
  }, 60_000);
});
