import { compileTypingChunks, type TypingCadence } from "../cadence";
import { parseStudioPlan, type StudioPlan } from "../plan";
import { STUDIO_GO_DOCK_TARGET_ID } from "../targets";

/**
 * Frozen copy of the cadence this fixture's hand-tuned `at` times were laid
 * out against. Deliberately NOT the shared named cadences — those evolve with
 * editorial taste, and this archived plan must keep matching its checked-in
 * narration audio.
 */
const M0_CADENCE: TypingCadence = {
  mode: "chars",
  charsPerSecond: 16,
  maxChunkChars: 4,
  lineBreakPauseMs: 200,
  jitter: 0.25,
};

/**
 * M0 vertical-slice plan (docs/agent-lesson-production.md §12): one hard-coded
 * ~22-second Go lesson — open a helper file, type a `cube` function, call it
 * from `main`, run, and assert the output — recorded against the pre-generated
 * narration in `public/studio-fixtures/m0-go-hello.m4a`.
 *
 * The narration was synthesized offline (macOS `say`, Samantha, then AAC via
 * `afconvert`; see scripts/generate-studio-narration.sh) and measures
 * 21 778 ms. All `at` times below were laid out against that waveform.
 */

const NARRATION_DURATION_MS = 21_778;

const MAIN_GO = `package main

import "fmt"

func main() {
\tfmt.Println("Hello, Go lessons!")

\tfor i := 1; i <= 5; i++ {
\t\tfmt.Printf("%d squared is %d\\n", i, square(i))
\t}
}
`;

const SQUARE_GO = `package main

func square(value int) int {
\treturn value * value
}
`;

const CUBE_FUNCTION = `
func cube(value int) int {
\treturn value * value * value
}
`;

const MAIN_CALL = `
\tfmt.Println("3 cubed is", cube(3))
`;

/** Deterministic program output — identical for the live Playground and the fixture. */
const EXPECTED_OUTPUT = [
  "Hello, Go lessons!",
  "1 squared is 1",
  "2 squared is 4",
  "3 squared is 9",
  "4 squared is 16",
  "5 squared is 25",
  "3 cubed is 27",
]
  .map((line) => `${line}\n`)
  .join("");

interface CueSpec {
  start: number;
  end: number;
  text: string;
}

/** Even per-word interpolation inside each cue — M1 replaces this with forced alignment. */
function toCue({ start, end, text }: CueSpec) {
  const tokens = text.split(" ").filter((token) => token.length > 0);
  const step = (end - start) / tokens.length;
  return {
    start,
    end,
    text,
    words: tokens.map((token, index) => ({
      start: Math.round(start + index * step),
      end: Math.round(start + (index + 1) * step),
      text: token,
    })),
  };
}

const CAPTION_CUES: CueSpec[] = [
  {
    start: 0,
    end: 5_400,
    text: "Go functions live at the package level, so any file in the package can call them.",
  },
  { start: 5_400, end: 8_400, text: "Square here takes an int, and returns an int." },
  {
    start: 8_400,
    end: 12_100,
    text: "Let's add a cube function beside it, multiplying value three times.",
  },
  { start: 12_100, end: 15_100, text: "Now call cube from main, and print the result." },
  { start: 15_100, end: 16_300, text: "Run the program." },
  {
    start: 16_300,
    end: 21_700,
    text: "The five squares print first, and then: three cubed is twenty seven.",
  },
];

const SEED = 42;

export const M0_GO_HELLO_SLUG = "m0-go-hello";

export function createM0GoHelloPlan(): StudioPlan {
  return parseStudioPlan({
    schemaVersion: 1,
    lesson: {
      slug: M0_GO_HELLO_SLUG,
      title: "Go functions: square to cube",
      locale: "en-US",
    },
    seed: SEED,
    workspace: {
      lessonType: "go",
      name: "Go Lesson",
      entryFilePath: "main.go",
      files: {
        "main.go": MAIN_GO,
        "square.go": SQUARE_GO,
      },
    },
    narration: {
      audioPath: "/studio-fixtures/m0-go-hello.m4a",
      mimeType: "audio/mp4",
      expectedDurationMs: NARRATION_DURATION_MS,
      captions: {
        id: "studio-narration",
        language: "en",
        label: "English",
        default: true,
        cues: CAPTION_CUES.map(toCue),
      },
    },
    runtime: {
      kind: "go-playground",
      defaultMode: "fixture",
      fixture: {
        latencyMs: 1_200,
        result: {
          status: "success",
          output: EXPECTED_OUTPUT,
          exitCode: 0,
        },
      },
    },
    actions: [
      {
        id: "cursor-to-square",
        type: "cursor.moveTo",
        at: 600,
        timeoutMs: 5_000,
        target: { kind: "file", path: "square.go" },
        durationMs: 700,
      },
      {
        id: "open-square",
        type: "workspace.openFile",
        at: 1_500,
        timeoutMs: 5_000,
        path: "square.go",
      },
      {
        id: "cursor-to-editor",
        type: "cursor.moveTo",
        at: 5_000,
        timeoutMs: 5_000,
        target: { kind: "editor" },
        durationMs: 600,
      },
      {
        id: "type-cube",
        type: "editor.type",
        at: 8_000,
        timeoutMs: 10_000,
        path: "square.go",
        anchor: { after: SQUARE_GO, occurrence: 1 },
        chunks: compileTypingChunks(CUBE_FUNCTION, M0_CADENCE, SEED),
      },
      {
        id: "cursor-to-main",
        type: "cursor.moveTo",
        at: 12_950,
        timeoutMs: 5_000,
        target: { kind: "file", path: "main.go" },
        durationMs: 500,
      },
      {
        id: "open-main",
        type: "workspace.openFile",
        at: 13_500,
        timeoutMs: 5_000,
        path: "main.go",
      },
      {
        id: "type-call",
        type: "editor.type",
        at: 13_700,
        timeoutMs: 10_000,
        path: "main.go",
        anchor: { after: `, square(i))\n\t}\n`, occurrence: 1 },
        chunks: compileTypingChunks(MAIN_CALL, M0_CADENCE, SEED + 1),
      },
      {
        id: "cursor-to-dock",
        type: "cursor.moveTo",
        at: 16_500,
        timeoutMs: 5_000,
        target: { kind: "target-id", id: STUDIO_GO_DOCK_TARGET_ID },
        durationMs: 500,
      },
      {
        id: "run",
        type: "runtime.run",
        at: 17_200,
        timeoutMs: 15_000,
      },
      {
        id: "expect-output",
        type: "expect.output",
        at: 17_300,
        timeoutMs: 6_000,
        contains: "3 cubed is 27",
      },
      {
        id: "expect-file-main",
        type: "expect.file",
        at: 17_300,
        timeoutMs: 5_000,
        path: "main.go",
        contains: `cube(3)`,
      },
    ],
  });
}
