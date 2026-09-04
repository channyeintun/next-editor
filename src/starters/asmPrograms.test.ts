import { describe, expect, it } from "vitest";
import { createStarterAsmWorkspace } from "./asm";
import { assembleAndRun } from "../core/x86";
import { isWorkspaceTextFile } from "../types/workspace";

/**
 * The starter has to be true.
 *
 * Its comments quote the output it produces, and a starter whose comments lie
 * is worse than no comments: the first thing a learner does is press Run, and
 * the first thing they learn would be that the file cannot be trusted. So the
 * program is assembled and executed here, and its real output is compared with
 * what it claims.
 */
describe("the assembly starter", () => {
  const project = createStarterAsmWorkspace();
  const file = project.files["main.asm"];
  if (!isWorkspaceTextFile(file)) throw new Error("the starter must be a text file");
  const source = file.content;

  it("names main.asm as its entry", () => {
    expect(project.entryFilePath).toBe("main.asm");
    expect(project.lessonType).toBe("asm");
  });

  it("assembles and runs, printing what its comments say it prints", () => {
    const result = assembleAndRun(source);

    expect(result.status).toBe("success");
    expect(result.stdout).toBe("Hello from the machine!\nrax now holds: 42\n");
    expect(result.exitCode).toBe(0);
  });

  it("prints nothing to stderr", () => {
    expect(assembleAndRun(source).stderr).toBe("");
  });
});
