import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { replayTypedFile } from "./crashCourseTestUtils";
import { parseLessonScript, type LessonScript } from "./script/schema";

/**
 * `replayTypedFile` replaced four hand-rolled copies of anchor resolution whose
 * rule was `indexOf` plus "the anchor must match exactly once". That rule is
 * stricter than the schema in one direction (it rejects `after: ""` and any
 * repeated anchor) and wrong in the other (it ignores `occurrence` entirely, so
 * it replays a target the driver resolves elsewhere). These cases pin the
 * driver's semantics the shared helper now uses.
 */

const fixturePath = resolve(__dirname, "./script/__fixtures__/go-swap.yaml");

type Typing = { after: string; occurrence?: number; text: string };

/** A minimal, schema-valid script that types `typings` into one `main.go`. */
function scriptTyping(file: string, typings: Typing[]): LessonScript {
  const raw = YAML.parse(readFileSync(fixturePath, "utf8"));
  raw.lesson.workspace.files = { "main.go": file };
  raw.scenes = [
    {
      id: "only",
      narration: "One small idea, typed into the file the lesson opens with.",
      actions: typings.map((typing, index) => ({
        id: `type-${index}`,
        type: "editor.type",
        at: { scene: "start" },
        target: { file: "main.go", after: typing.after, occurrence: typing.occurrence ?? 1 },
        text: typing.text,
      })),
    },
  ];
  return parseLessonScript(raw);
}

describe("replayTypedFile", () => {
  it("treats an empty anchor as the start of the file", () => {
    // Schema-legal (`after: z.string()`), and the copies it replaced failed it:
    // "".split("") yields one piece per character, never exactly one match.
    const script = scriptTyping("world\n", [{ after: "", text: "hello " }]);
    expect(replayTypedFile(script, "main.go")).toBe("hello world\n");
  });

  it("inserts after the requested occurrence of a repeated anchor", () => {
    const script = scriptTyping("a\na\n", [{ after: "a\n", occurrence: 2, text: "b\n" }]);
    expect(replayTypedFile(script, "main.go")).toBe("a\na\nb\n");
  });

  it("counts occurrences in the file as it stands at that moment", () => {
    // The second insertion's anchor only exists because the first one typed it,
    // which is what makes replaying in order — rather than resolving against
    // the initial file — the thing that matches a render.
    const script = scriptTyping("a\n", [
      { after: "a\n", text: "a\n" },
      { after: "a\n", occurrence: 2, text: "b\n" },
    ]);
    expect(replayTypedFile(script, "main.go")).toBe("a\na\nb\n");
  });
});
