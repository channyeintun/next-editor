import { describe, expect, it } from "vite-plus/test";
import type { Recording } from "../core/src/types";
import type { WorkspaceProject, WorkspaceRecordingSnapshot } from "../types/workspace";
import { buildCaptionPrompt, segmentsToCues } from "./generateCaptions";

describe("segmentsToCues", () => {
  it("places segments on the recording's clock", () => {
    expect(segmentsToCues([{ start: 0, end: 2.5, text: "Hello there." }], 1000, 60_000)).toEqual([
      { start: 1000, end: 3500, text: "Hello there." },
    ]);
  });

  it("keeps cues within the recording, dropping any past its end", () => {
    expect(
      segmentsToCues(
        [
          { start: 58, end: 62, text: "The last words." },
          { start: 61, end: 63, text: "Past the end." },
        ],
        0,
        60_000,
      ),
    ).toEqual([{ start: 58_000, end: 60_000, text: "The last words." }]);
  });

  it("splits a long segment at a sentence, sharing its time by characters", () => {
    const first = "First sentence is here.";
    const second = "Second sentence is also here and it keeps going on for a while.";
    expect(segmentsToCues([{ start: 0, end: 8.6, text: `${first} ${second}` }], 0, 60_000)).toEqual(
      [
        { start: 0, end: 2300, text: first },
        { start: 2300, end: 8600, text: second },
      ],
    );
  });

  it("splits a segment that runs long in time, even when its text is short", () => {
    const cues = segmentsToCues(
      [{ start: 0, end: 15, text: "We open the file, then we add a state hook, and we save it." }],
      0,
      60_000,
    );
    expect(cues.map((cue) => cue.text)).toEqual([
      "We open the file,",
      "then we add a state hook,",
      "and we save it.",
    ]);
    expect(cues[0].start).toBe(0);
    expect(cues[cues.length - 1].end).toBe(15_000);
    for (const cue of cues) expect(cue.end - cue.start).toBeLessThanOrEqual(7_000);
  });
});

function project(files: Record<string, string>): WorkspaceProject {
  return {
    id: "project",
    name: "Lesson",
    lessonType: "react",
    entryFilePath: "src/App.tsx",
    folders: ["src"],
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        { path, name: path.split("/").pop() ?? path, language: "plaintext", content },
      ]),
    ),
  };
}

function recording(snapshots: { initial?: WorkspaceProject; events?: WorkspaceProject[] }) {
  const snapshot = (value: WorkspaceProject): WorkspaceRecordingSnapshot => ({
    project: value,
    activeFilePath: value.entryFilePath,
  });
  return {
    workspaceSnapshot: snapshots.initial && snapshot(snapshots.initial),
    workspaceEvents: snapshots.events?.map((value, index) => ({
      timestamp: index * 1000,
      snapshot: snapshot(value),
    })),
  } as Recording;
}

describe("buildCaptionPrompt", () => {
  const manifest = JSON.stringify({
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", "@types/react": "^19.0.0" },
    devDependencies: { vite: "^7.0.0", typescript: "^5.9.0" },
  });

  it("names the lesson's libraries and files", () => {
    const lesson = project({
      "package.json": manifest,
      "index.html": "",
      "src/App.tsx": "",
      ".gitignore": "",
    });
    expect(buildCaptionPrompt(recording({ initial: lesson }))).toBe(
      "A coding lesson using React, React DOM, Vite, TypeScript, in package.json, index.html, App.tsx.",
    );
  });

  it("reads the workspace as the lesson ends", () => {
    const start = project({ "src/App.tsx": "" });
    const end = project({ "src/App.tsx": "", "src/Counter.tsx": "" });
    expect(buildCaptionPrompt(recording({ initial: start, events: [end] }))).toBe(
      "A coding lesson using React, in App.tsx, Counter.tsx.",
    );
  });

  it("still lists the files while package.json is not valid JSON", () => {
    const lesson = project({ "package.json": '{ "dependencies": {', "src/App.tsx": "" });
    expect(buildCaptionPrompt(recording({ initial: lesson }))).toBe(
      "A coding lesson using React, in package.json, App.tsx.",
    );
  });

  it("gives no prompt without a workspace", () => {
    expect(buildCaptionPrompt(recording({}))).toBeUndefined();
  });
});
