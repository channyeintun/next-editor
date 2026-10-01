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

  // Pinned from before Burmese breaks and grapheme lengths: English must split as it did.
  it("splits English exactly as it always has", () => {
    const text =
      "Now we create the store with an initial context; it holds the count, the step, and the history. " +
      "Then we add an event called increment: it reads the step, adds it to the count, and pushes the old value onto the history list so that undo works later without any extra bookkeeping in the component itself!";
    expect(segmentsToCues([{ start: 1.2, end: 24.7, text }], 500, 60_000)).toEqual([
      {
        start: 1700,
        end: 7851,
        text: "Now we create the store with an initial context; it holds the count, the step,",
      },
      { start: 7851, end: 9113, text: "and the history." },
      {
        start: 9113,
        end: 15343,
        text: "Then we add an event called increment: it reads the step, adds it to the count,",
      },
      {
        start: 15343,
        end: 21888,
        text: "and pushes the old value onto the history list so that undo works later without any",
      },
      { start: 21888, end: 25200, text: "extra bookkeeping in the component itself!" },
    ]);
  });

  const burmeseSentence = "ဒီသင်ခန်းစာမှာ store တစ်ခုကို အစကနေ တည်ဆောက်ပြီး အသုံးပြုပုံကို လေ့လာကြမယ်။";

  it("splits Burmese at its full stop, even with no space after it", () => {
    const cues = segmentsToCues(
      [{ start: 0, end: 20, text: burmeseSentence.repeat(3) }],
      0,
      60_000,
    );
    expect(cues).toEqual([
      { start: 0, end: 6667, text: burmeseSentence },
      { start: 6667, end: 13333, text: burmeseSentence },
      { start: 13333, end: 20000, text: burmeseSentence },
    ]);
  });

  it("splits a long Burmese sentence at its phrase marks", () => {
    const text =
      "ပထမဆုံး context ကို သတ်မှတ်မယ်၊ နောက်တော့ event တွေကို ထည့်မယ်၊ ပြီးရင် component ထဲမှာ သုံးမယ်၊ နောက်ဆုံးမှာ စမ်းသပ်ကြည့်မယ်။";
    expect(segmentsToCues([{ start: 0, end: 12, text }], 0, 60_000).map((cue) => cue.text)).toEqual(
      [
        "ပထမဆုံး context ကို သတ်မှတ်မယ်၊ နောက်တော့ event တွေကို ထည့်မယ်၊",
        "ပြီးရင် component ထဲမှာ သုံးမယ်၊ နောက်ဆုံးမှာ စမ်းသပ်ကြည့်မယ်။",
      ],
    );
  });

  it("measures a Burmese cue in the characters a reader sees", () => {
    // 89 UTF-16 code units, but 60 characters on screen: it fits one cue.
    const text = `${burmeseSentence}ပထမစာကြောင်းပါ။`;
    expect(text.length).toBeGreaterThan(84);
    expect(segmentsToCues([{ start: 0, end: 6, text }], 0, 60_000)).toEqual([
      { start: 0, end: 6000, text },
    ]);
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
