import { describe, expect, it } from "vite-plus/test";
import { LESSON_SCRIPTS_FOLDER } from "../plans/publishedScripts";
import { buildWorkflowIssueReport, type WorkflowIssueInput } from "./workflowIssue";

function issueInput(patch: Partial<WorkflowIssueInput>): WorkflowIssueInput {
  return {
    step: "render",
    slug: "go-error-values",
    title: "Error values",
    imported: false,
    message: "text not found",
    phase: "perform",
    position: { index: 0, total: 1, done: 0 },
    narration: { provider: "Pocket-TTS", voice: null, runtimeMode: null },
    report: null,
    buildWarnings: [],
    atIso: "2026-11-24T00:00:00.000Z",
    origin: "https://nexteditor.dev",
    userAgent: "test",
    ...patch,
  };
}

describe("buildWorkflowIssueReport", () => {
  it("names the lesson's file and the published script the studio rendered", () => {
    const id = "c".repeat(64);
    const report = buildWorkflowIssueReport(issueInput({ publishedId: id }));
    expect(report).toContain(
      `- Lesson: Error values — \`${LESSON_SCRIPTS_FOLDER}/go-error-values.yaml\`, published as \`${id}\``,
    );
  });

  it("names the file alone when the published id is not known", () => {
    const report = buildWorkflowIssueReport(issueInput({}));
    expect(report).toContain(`\`${LESSON_SCRIPTS_FOLDER}/go-error-values.yaml\`\n`);
    expect(report).not.toContain("published as");
  });

  it("says an imported lesson is not in the folder", () => {
    const report = buildWorkflowIssueReport(issueInput({ imported: true, publishedId: null }));
    expect(report).toContain("imported in the studio (not a checked-in script)");
    expect(report).not.toContain(LESSON_SCRIPTS_FOLDER);
  });
});
