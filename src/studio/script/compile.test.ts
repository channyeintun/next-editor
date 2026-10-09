import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { canonicalJson } from "../hash";
import { estimateAlignment, sceneStartMs } from "./alignment";
import { CompileError, compileLessonScript, type CompileInput } from "./compile";
import { splitIntoDialogs } from "./dialogs";
import { LEXICON_V1, speechTextOf, spokenFormOf } from "./lexicon";
import { extractScriptNarration } from "./markers";
import { scheduleDialogs } from "./schedule";
import { parseLessonScript, type LessonScript } from "./schema";

const PILOT_PATH = resolve(__dirname, "./__fixtures__/go-cube.yaml");
const PILOT_DURATION_MS = 21_778;

function loadPilotScript(): LessonScript {
  return parseLessonScript(YAML.parse(readFileSync(PILOT_PATH, "utf8")));
}

/**
 * Legacy fixed-timeline input: a whole-narration estimated alignment where
 * dialogs cannot move. Kept for the failure-gate tests — compile must reject
 * impossible timelines when fed one.
 */
function compileInputFor(script: LessonScript, durationMs = PILOT_DURATION_MS): CompileInput {
  const extracted = extractScriptNarration(script);
  return {
    script,
    extracted,
    alignment: estimateAlignment(extracted.tokens, durationMs, LEXICON_V1),
    narration: { audioPath: "/studio-fixtures/cache/test.m4a", mimeType: "audio/mp4", durationMs },
  };
}

/**
 * The production path: dialogs scheduled around the actions (narration waits
 * for typing), with deterministic fake per-dialog durations.
 */
function scheduledInputFor(script: LessonScript): CompileInput {
  const extracted = extractScriptNarration(script);
  const dialogs = splitIntoDialogs(extracted);
  const schedule = scheduleDialogs({
    script,
    extracted,
    dialogs,
    durationsMs: dialogs.map((dialog) => 400 + dialog.tokens.length * 320),
    lexicon: LEXICON_V1,
  });
  return {
    script,
    extracted,
    alignment: schedule.alignment,
    narration: {
      audioPath: "studio-tts://test",
      mimeType: "audio/wav",
      durationMs: schedule.totalDurationMs,
    },
  };
}

describe("lexicon", () => {
  it("applies to the token core and keeps punctuation", () => {
    expect(spokenFormOf("Println,", LEXICON_V1)).toBe("print linn,");
    expect(spokenFormOf("(fmt)", LEXICON_V1)).toBe("(fumt)");
    expect(spokenFormOf("unknown.", LEXICON_V1)).toBe("unknown.");
  });

  it("builds speech text without touching display tokens", () => {
    const tokens = ["Call", "Println", "now."];
    expect(speechTextOf(tokens, LEXICON_V1)).toBe("Call print linn now.");
    expect(tokens[1]).toBe("Println");
  });
});

/** A minimal Go script whose only edit is an `editor.select` drag-highlight. */
function selectScript(): LessonScript {
  return parseLessonScript({
    schemaVersion: 1,
    lesson: {
      slug: "go-select",
      title: "Highlighting a line",
      locale: "en-US",
      workspace: {
        lessonType: "go",
        name: "Go Lesson",
        entryFilePath: "main.go",
        files: { "main.go": 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n' },
      },
    },
    build: { voiceProfile: "pocket-alba-v1", seed: 7 },
    runtime: {
      kind: "go-playground",
      defaultMode: "fixture",
      fixture: { latencyMs: 100, result: { status: "success", output: "hi\n", exitCode: 0 } },
    },
    scenes: [
      {
        id: "look",
        narration:
          "First we open the program. [[mark:open]] Here is main, the entry point. " +
          "[[mark:point]] Look at this line closely, it prints hi to the screen for us.",
        sources: [{ title: "A Tour of Go", url: "https://go.dev/tour/welcome/1" }],
        actions: [
          { id: "open", type: "workspace.openFile", at: { mark: "open" }, path: "main.go" },
          {
            id: "point",
            type: "editor.select",
            at: { mark: "point" },
            target: { file: "main.go", text: 'println("hi")', occurrence: 1 },
          },
        ],
      },
    ],
    checks: [{ type: "timing.p95Ms", max: 300 }],
  });
}

describe("compileLessonScript", () => {
  it("materializes an editor.select drag and adds no cursor move to the editor", () => {
    const { plan } = compileLessonScript(scheduledInputFor(selectScript()));

    const select = plan.actions.find((action) => action.id === "point");
    if (select?.type !== "editor.select") throw new Error("select action was not compiled");
    expect(select.path).toBe("main.go");
    expect(select.selection).toEqual({ text: 'println("hi")', occurrence: 1 });
    expect(select.durationMs).toBeGreaterThan(0);

    // The select performs its own pointer drag, so no standalone attention
    // cursor glides to the middle of the editor before it (that drift read as
    // random mouse movement). openFile/run cursors still target real click
    // points; only the editor target is gone.
    const editorCursor = plan.actions.some(
      (action) => action.type === "cursor.moveTo" && action.target.kind === "editor",
    );
    expect(editorCursor).toBe(false);
  });

  it("takes the pointer to no file row for the file that is already showing", () => {
    // selectScript opens main.go, its entry file: the row would click nothing.
    const { plan } = compileLessonScript(scheduledInputFor(selectScript()));

    expect(plan.actions.some((action) => action.type === "cursor.moveTo")).toBe(false);
  });

  it("clicks the Run button while the dock is open and its chevron while it is shut", () => {
    const base = selectScript();
    const script = parseLessonScript({
      ...base,
      runtime: { ...base.runtime, dockStartsCollapsed: true },
      scenes: [
        {
          ...base.scenes[0],
          narration:
            "First we open the program. [[mark:open]] Here is main, the entry point, and " +
            "[[mark:run]] we run it right away to see it print a greeting. Then we hide the " +
            "console again [[mark:shut]] and look at the code for a while, reading it line by " +
            "line before [[mark:again]] we run it one more time to check the output.",
          actions: [
            { id: "run", type: "runtime.run", at: { mark: "run" } },
            { id: "shut", type: "runtime.collapseDock", at: { mark: "shut" } },
            { id: "again", type: "runtime.run", at: { mark: "again" } },
          ],
        },
      ],
    });
    const { plan } = compileLessonScript(scheduledInputFor(script));
    const byId = (id: string) => plan.actions.find((action) => action.id === id);
    const order = (...ids: string[]) =>
      ids.map((id) => plan.actions.findIndex((action) => action.id === id));

    // The dock starts shut: its chevron is clicked, the dock opens, and only
    // then is Run pressed — the chevron never seems to run the program.
    expect(byId("cursor-run-dock")).toMatchObject({
      type: "cursor.moveTo",
      target: { kind: "target-id", id: "runtime-dock-toggle" },
      press: true,
    });
    expect(byId("open-dock-run")).toMatchObject({ type: "runtime.expandDock" });
    expect(byId("cursor-run")).toMatchObject({ target: { kind: "run-button" }, press: true });
    const [chevron, opening, runPress, run] = order(
      "cursor-run-dock",
      "open-dock-run",
      "cursor-run",
      "run",
    );
    expect(chevron).toBeLessThan(opening);
    expect(opening).toBeLessThan(runPress);
    expect(runPress).toBeLessThan(run);
    // Collapsing clicks the same chevron…
    expect(byId("cursor-shut")).toMatchObject({
      target: { kind: "target-id", id: "runtime-dock-toggle" },
    });
    // …and with the dock shut once more, the second run opens it the same way.
    expect(byId("cursor-again-dock")).toMatchObject({
      target: { kind: "target-id", id: "runtime-dock-toggle" },
    });
    expect(byId("cursor-again")).toMatchObject({ target: { kind: "run-button" } });

    const open = parseLessonScript({ ...script, runtime: base.runtime });
    expect(
      compileLessonScript(scheduledInputFor(open)).plan.actions.find(
        (action) => action.id === "cursor-run",
      ),
    ).toMatchObject({ target: { kind: "run-button" }, press: true });
  });

  it("releases each click just before the action it performs, from a deterministic budget", () => {
    const { plan } = compileLessonScript(scheduledInputFor(loadPilotScript()));
    const moves = plan.actions.filter((action) => action.type === "cursor.moveTo");

    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) {
      const performed = plan.actions.find((action) => `cursor-${action.id}` === move.id)!;
      expect(move.press).toBe(true);
      expect(move.at + move.durationMs).toBe(performed.at - 80);
      // The longest approach plus the rest and the press — never more.
      expect(move.durationMs).toBeLessThanOrEqual(800 + 220 + 100);
    }
  });

  it("compiles console.point as a timed pointing gesture at a line the program prints", () => {
    const base = selectScript();
    const script = parseLessonScript({
      ...base,
      scenes: [
        {
          ...base.scenes[0],
          narration:
            "First we open the program. [[mark:run]] Let's run it and look at what it prints. " +
            "[[mark:read]] The console shows one short line, the greeting hi, printed by main.",
          actions: [
            { id: "run", type: "runtime.run", at: { mark: "run", offsetMs: 200 } },
            {
              id: "read",
              type: "console.point",
              at: { mark: "read" },
              target: { text: "hi" },
            },
          ],
        },
      ],
    });

    const { plan } = compileLessonScript(scheduledInputFor(script));
    const point = plan.actions.find((action) => action.id === "read");

    expect(point).toMatchObject({
      type: "console.point",
      target: { text: "hi", occurrence: 1 },
      durationMs: 800,
    });
    // A gesture of its own: no derived click precedes it.
    expect(plan.actions.some((action) => action.id === "cursor-read")).toBe(false);
  });

  // A script-only check: the schema rejects it at parse time, before any
  // narration is synthesized for a render that would fail at the pointer.
  it("rejects a console.point at a line the pinned output never prints", () => {
    const base = selectScript();
    const script = {
      ...base,
      scenes: [
        {
          ...base.scenes[0],
          narration:
            "First we open the program. [[mark:read]] Now look at the second line it prints.",
          actions: [
            { id: "read", type: "console.point", at: { mark: "read" }, target: { text: "bye" } },
          ],
        },
      ],
    };

    expect(() => parseLessonScript(script)).toThrow(
      /console.point "read" targets output line 1 containing "bye", but the run's console has 0 such lines/,
    );
  });

  describe("console.point placement", () => {
    // selectScript's Go program, made to print `output` (and, optionally, vet notes).
    function pointing(
      actions: unknown[],
      { output = "hi\n", vetErrors, dockStartsCollapsed = false } = {} as {
        output?: string;
        vetErrors?: string;
        dockStartsCollapsed?: boolean;
      },
    ) {
      const base = selectScript();
      return parseLessonScript({
        ...base,
        runtime: {
          ...base.runtime,
          dockStartsCollapsed,
          fixture: {
            latencyMs: 100,
            // Go reports vet notes on a run that still ran: status "vet-error", exit 0.
            result: vetErrors
              ? { status: "vet-error", exitCode: 0, output, vetErrors }
              : { status: "success", exitCode: 0, output },
          },
        },
        scenes: [
          {
            ...base.scenes[0],
            narration:
              "First we open the program. [[mark:a]] Let's run it and see. [[mark:b]] Here is the first " +
              "line it printed. [[mark:c]] Now we close the console. [[mark:d]] And look at this line again.",
            actions,
          },
        ],
      });
    }
    const run = { id: "run", type: "runtime.run", at: { mark: "a" } };
    const point = (mark: string, text: string) => ({
      id: `point-${mark}`,
      type: "console.point",
      at: { mark },
      target: { text },
    });

    it("needs output on the console first", () => {
      expect(() =>
        compileLessonScript(
          scheduledInputFor(pointing([point("b", "hi"), { ...run, at: { mark: "c" } }])),
        ),
      ).toThrow(/console.point "point-b" comes before the lesson's first runtime.run/);
    });

    it("needs the dock open, and opens again with the next run", () => {
      const collapse = { id: "shut", type: "runtime.collapseDock", at: { mark: "c" } };
      expect(() =>
        compileLessonScript(scheduledInputFor(pointing([run, collapse, point("d", "hi")]))),
      ).toThrow(/points at the console while the runner dock is shut/);
      expect(() =>
        compileLessonScript(
          scheduledInputFor(pointing([run, point("b", "hi")], { dockStartsCollapsed: true })),
        ),
      ).not.toThrow();
    });

    it("only points at lines still on screen — the console keeps its last six rows", () => {
      const sixLines = "one\ntwo\nthree\nfour\nfive\nsix\n";
      // six output lines plus the exit line: the first has scrolled away.
      expect(() =>
        compileLessonScript(
          scheduledInputFor(pointing([run, point("b", "one")], { output: sixLines })),
        ),
      ).toThrow(/"one", which has scrolled out of the console/);
      expect(() =>
        compileLessonScript(
          scheduledInputFor(pointing([run, point("b", "two")], { output: sixLines })),
        ),
      ).not.toThrow();
    });

    it("refuses a point that would land on a vet warning instead of the output", () => {
      expect(() =>
        compileLessonScript(
          scheduledInputFor(
            pointing([run, point("b", "name")], {
              output: "name: Ada\n",
              vetErrors: "./main.go:4:2: name declared and not used",
            }),
          ),
        ),
      ).toThrow(/lands on the runner's warning line/);
    });

    it("matches tabs as the console shows them", () => {
      expect(() =>
        compileLessonScript(
          scheduledInputFor(pointing([run, point("b", "Name:   Ada")], { output: "Name:\tAda\n" })),
        ),
      ).not.toThrow();
      expect(() => pointing([run, point("b", "Name:\tAda")], { output: "Name:\tAda\n" })).toThrow(
        /tab as spaces/,
      );
    });
  });

  it("only lets console lessons point at the console", () => {
    const base = selectScript();
    const noRuntime = {
      ...base,
      lesson: {
        ...base.lesson,
        workspace: {
          lessonType: "javascript",
          name: "JS",
          entryFilePath: "index.js",
          files: { "index.js": "console.log(1)\n", "package.json": "{}" },
        },
      },
      runtime: {
        kind: "webcontainer",
        adapterVersion: 1,
        defaultMode: "live",
        initCommand: "pnpm install",
        runCommand: "pnpm dev",
        environment: {},
      },
      scenes: [
        {
          ...base.scenes[0],
          narration: "Look at this. [[mark:read]] The output shows one.",
          actions: [
            { id: "read", type: "console.point", at: { mark: "read" }, target: { text: "1" } },
          ],
        },
      ],
    };

    expect(() => parseLessonScript(noRuntime)).toThrow(/console.point.*preview lesson/);
  });

  it("starts a chapter at the first spoken word of each scene that titles one", () => {
    const script = loadPilotScript();
    const [first, second] = script.scenes;
    const titled: LessonScript = {
      ...script,
      scenes: [first, { ...second, chapter: "Calling it" }],
    };
    const input = scheduledInputFor(titled);
    const { plan } = compileLessonScript(input);

    expect(plan.chapters).toHaveLength(1);
    expect(plan.chapters[0].title).toBe("Calling it");
    // At the scene's first spoken word.
    expect(plan.chapters[0].time).toBe(sceneStartMs(input.alignment, input.extracted, second.id));
    // An untitled lesson has none.
    expect(compileLessonScript(scheduledInputFor(script)).plan.chapters).toEqual([]);
  });

  // The player's current chapter is the last one starting at or before the
  // playhead, so an opening chapter at the first word (after the recording's
  // lead-in) left the first seconds with none.
  it("starts the opening scene's chapter at the very beginning", () => {
    const script = loadPilotScript();
    const [first, second] = script.scenes;
    const titled: LessonScript = {
      ...script,
      scenes: [
        { ...first, chapter: "The cube" },
        { ...second, chapter: "Calling it" },
      ],
    };
    const input = scheduledInputFor(titled);
    const { plan } = compileLessonScript(input);

    expect(sceneStartMs(input.alignment, input.extracted, first.id)).toBeGreaterThan(0);
    expect(plan.chapters).toEqual([
      { time: 0, title: "The cube" },
      { time: sceneStartMs(input.alignment, input.extracted, second.id), title: "Calling it" },
    ]);
  });

  it("compiles the checked-in pilot script into a valid plan", () => {
    const { plan, warnings } = compileLessonScript(scheduledInputFor(loadPilotScript()));

    expect(plan.lesson.slug).toBe("go-cube");
    expect(plan.gates?.timingP95MaxMs).toBe(300);
    expect(plan.narration.captions.cues.length).toBeGreaterThan(3);
    // Derived pointer clicks precede the actions they perform.
    const ids = plan.actions.map((action) => action.id);
    expect(ids.indexOf("cursor-open-square")).toBeLessThan(ids.indexOf("open-square"));
    expect(ids.indexOf("cursor-run")).toBeLessThan(ids.indexOf("run"));
    expect(warnings.length).toBeLessThanOrEqual(2);

    // A pointer move must never be ordered before a real action scheduled at
    // the same instant: the serial Performer would let the ~1s move block it,
    // drifting the real action off its planned mark.
    const cursorBlocksSameInstantAction = plan.actions.some(
      (action, i) =>
        i > 0 &&
        plan.actions[i - 1].at === action.at &&
        plan.actions[i - 1].type === "cursor.moveTo" &&
        action.type !== "cursor.moveTo",
    );
    expect(cursorBlocksSameInstantAction).toBe(false);
  });

  it("is deterministic — identical inputs produce identical plans", () => {
    const first = compileLessonScript(scheduledInputFor(loadPilotScript()));
    const second = compileLessonScript(scheduledInputFor(loadPilotScript()));
    expect(canonicalJson(second.plan)).toBe(canonicalJson(first.plan));
  });

  it("fails before render on an unknown marker", () => {
    const script = loadPilotScript();
    const open = script.scenes[0].actions.find((action) => action.id === "open-square")!;
    open.at = { mark: "no-such-mark", offsetMs: 0 };
    expect(() => compileLessonScript(compileInputFor(script))).toThrow(/Unknown marker/);
  });

  it("fails before render when typing cannot fit before the next action", () => {
    const script = loadPilotScript();
    const typeCube = script.scenes[0].actions.find((action) => action.id === "type-cube");
    if (typeCube?.type !== "editor.type") throw new Error("pilot lost its typing action");
    // Repeat the payload until it cannot finish before the next authored action.
    typeCube.text = typeCube.text.repeat(6);
    expect(() => compileLessonScript(compileInputFor(script))).toThrow(CompileError);
    expect(() => compileLessonScript(compileInputFor(script))).toThrow(
      /adjust the script's marks\/offsets: .*Typing action "type-cube" \(\d+ms\) overlaps/,
    );
  });

  it("fails before render when an action lands after the narration ends", () => {
    const script = loadPilotScript();
    const run = script.scenes[1].actions.find((action) => action.id === "run")!;
    run.at = { mark: "run", offsetMs: 25_000 };
    expect(() => compileLessonScript(compileInputFor(script))).toThrow(CompileError);
    expect(() => compileLessonScript(compileInputFor(script))).toThrow(
      /adjust the script's marks\/offsets: .*starts after the narration ends/,
    );
  });

  // Moving marks cannot fix a plan rule the script schema let through, so the
  // timing advice must not be attached to it.
  it("keeps the marks/offsets advice to timeline failures", () => {
    const raw = YAML.parse(readFileSync(TOUR_PATH, "utf8"));
    const script = parseLessonScript(raw);
    const closeBoard = script.scenes[1].actions.find((action) => action.id === "close-board");
    if (closeBoard?.type !== "whiteboard.apply") throw new Error("tour lost its close action");
    delete closeBoard.open;

    const compile = () => compileLessonScript(scheduledInputFor(script));
    expect(compile).toThrow(CompileError);
    // Anchored, so the "— adjust the script's marks/offsets" variant fails it.
    expect(compile).toThrow(/^Compiled plan failed validation: .*whiteboard\.apply must open/);
  });

  it("resolves afterAction chains and rejects cycles", () => {
    const script = loadPilotScript();
    const expectOutput = script.scenes[1].actions.find((action) => action.id === "expect-output")!;
    const run = script.scenes[1].actions.find((action) => action.id === "run")!;
    // run → after expect-output → after run: a cycle.
    run.at = { afterAction: "expect-output" };
    expectOutput.at = { afterAction: "run" };
    expect(() => compileLessonScript(compileInputFor(script))).toThrow(/cycle/);
  });

  // Zero-busy dependents of one predecessor all land on the same instant, and the
  // Performer executes plan order strictly sequentially — so the compiled order at
  // that instant has to be the order the author wrote.
  it("keeps authored order for actions sharing one afterAction predecessor", () => {
    const script = loadPilotScript();
    const scene = script.scenes[1];
    const run = scene.actions.find((action) => action.id === "run")!;
    const expectOutput = scene.actions.find((action) => action.id === "expect-output")!;
    const expectFile = scene.actions.find((action) => action.id === "expect-file-main")!;
    expectOutput.at = { afterAction: "run" };
    expectFile.at = { afterAction: "run" };

    const { plan } = compileLessonScript(scheduledInputFor(script));
    const order = plan.actions.map((action) => action.id);
    const runIndex = order.indexOf(run.id);
    expect(order.indexOf("expect-output")).toBeGreaterThan(runIndex);
    expect(order.indexOf("expect-file-main")).toBeGreaterThan(order.indexOf("expect-output"));
    // Same instant — the tiebreak, not the timestamp, is what orders them.
    const at = (id: string) => plan.actions.find((action) => action.id === id)!.at;
    expect(at("expect-file-main")).toBe(at("expect-output"));
  });
});

const TOUR_PATH = resolve(__dirname, "./__fixtures__/go-cube-tour.yaml");

describe("multi-surface pilot (go-cube-tour)", () => {
  function loadTourScript(): LessonScript {
    return parseLessonScript(YAML.parse(readFileSync(TOUR_PATH, "utf8")));
  }

  it("compiles slide and whiteboard actions into the plan", () => {
    const script = loadTourScript();
    const { plan } = compileLessonScript(scheduledInputFor(script));

    const types = new Set(plan.actions.map((action) => action.type));
    expect(types).toContain("slide.show");
    expect(types).toContain("slide.close");
    expect(types).toContain("whiteboard.apply");
    expect(types).toContain("editor.type");
    expect(types).toContain("runtime.run");
    expect(plan.slides).toHaveLength(1);
    expect(plan.whiteboardAssets).toHaveLength(2);
    if (plan.runtime.kind !== "go-playground") throw new Error("tour pilot lost its runtime");
    expect(plan.runtime.fixture.transientErrorKinds).toEqual(["unavailable"]);
  });

  it("rejects a slide.show for an unpinned slide", () => {
    const raw = YAML.parse(readFileSync(TOUR_PATH, "utf8"));
    raw.scenes[0].actions[0].slideId = "ghost";
    expect(() => parseLessonScript(raw)).toThrow(/not a pinned slide asset/);
  });

  it("rejects whiteboard upserts of unpinned assets", () => {
    const raw = YAML.parse(readFileSync(TOUR_PATH, "utf8"));
    raw.scenes[1].actions[0].upsertIds = ["ghost"];
    expect(() => parseLessonScript(raw)).toThrow(/not pinned/);
  });

  // The Performer emits a drawn apply frame by frame and runs strictly
  // sequentially, so an unmodelled draw would start every later action late
  // and fail the timing gate.
  it("models a drawn apply as busy time", () => {
    const raw = YAML.parse(readFileSync(TOUR_PATH, "utf8"));
    raw.scenes[1].actions[0].drawMs = 600;
    raw.scenes[1].actions[1].at = { afterAction: "open-board" };

    const { plan } = compileLessonScript(scheduledInputFor(parseLessonScript(raw)));
    const at = (id: string) => plan.actions.find((action) => action.id === id)!.at;
    expect(at("label-board") - at("open-board")).toBe(600);
  });

  it("rejects a draw budget the action's own timeout cannot cover", () => {
    const raw = YAML.parse(readFileSync(TOUR_PATH, "utf8"));
    raw.scenes[1].actions[0].drawMs = 3_000;
    raw.scenes[1].actions[0].timeoutMs = 1_000;
    expect(() => parseLessonScript(raw)).toThrow(/shorter than the action's timeoutMs/);
  });
});

describe("lessonScriptSchema", () => {
  it("accepts the checked-in pilot", () => {
    const script = loadPilotScript();
    expect(script.scenes).toHaveLength(2);
    expect(script.scenes.every((scene) => scene.sources.length > 0)).toBe(true);
  });

  it("rejects actions referencing files outside the pinned workspace", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    raw.scenes[0].actions[0].path = "missing.go";
    expect(() => parseLessonScript(raw)).toThrow(/not in the pinned workspace/);
  });

  it("rejects unknown afterAction references", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    raw.scenes[1].actions[3].at = { afterAction: "ghost" };
    expect(() => parseLessonScript(raw)).toThrow(/unknown action "ghost"/);
    // Reported once, as unknown — not again as an unresolvable chain.
    expect(() => parseLessonScript(raw)).not.toThrow(/cycle/);
  });

  // Script-only failures used to surface from the compiler, after every dialog
  // had been synthesized; the schema now rejects them wherever a script parses.
  it("rejects an anchor to an unknown mark and names the known ones", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    raw.scenes[0].actions[0].at = { mark: "no-such-mark" };
    expect(() => parseLessonScript(raw)).toThrow(
      /scenes\.0\.actions\.0\.at\.mark: Unknown marker "no-such-mark" — known markers: /,
    );
  });

  it("rejects narration whose markers cannot be extracted", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    raw.scenes[1].narration = `${raw.scenes[1].narration} [[mark:oops`;
    expect(() => parseLessonScript(raw)).toThrow(/malformed marker/);
  });

  it("rejects an afterAction cycle", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    const actions: { id: string; at: unknown }[] = raw.scenes[1].actions;
    const run = actions.find((action) => action.id === "run")!;
    const expectOutput = actions.find((action) => action.id === "expect-output")!;
    run.at = { afterAction: "expect-output" };
    expectOutput.at = { afterAction: "run" };
    // expect-file-main runs after `run`, so it hangs off the cycle too.
    expect(() => parseLessonScript(raw)).toThrow(
      /Unresolvable afterAction chain \(cycle\?\): run, expect-output, expect-file-main$/,
    );
  });

  // Every skill and doc says to include the timing gate, but `checks` defaulted
  // to [] — so omitting it silently rendered with no timing gate at all.
  it("rejects a lesson that declares no timing gate", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    raw.checks = [];
    expect(() => parseLessonScript(raw)).toThrow(/must declare a timing gate/);
  });

  // `actions` defaults to [], so a narration-only script used to parse and only
  // blow up later inside plan validation with an unrelated message.
  it("rejects a lesson with no actions in any scene", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    for (const scene of raw.scenes) {
      scene.actions = [];
    }
    expect(() => parseLessonScript(raw)).toThrow(/no actions/);
  });

  // zod strips unknown keys by default, so each of these used to parse and
  // render with the default (natural cadence, zero offset, the mark alone).
  it("rejects a misspelled action key and names it", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    raw.scenes[0].actions[1].cadance = "block";
    expect(() => parseLessonScript(raw)).toThrow(
      /scenes\.0\.actions\.1: Unrecognized key: "cadance"/,
    );
  });

  it("rejects a misspelled anchor key and names it", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    raw.scenes[0].actions[1].at = { mark: "type-cube", offsetMS: -600 };
    expect(() => parseLessonScript(raw)).toThrow(
      /scenes\.0\.actions\.1\.at: Unrecognized key: "offsetMS"/,
    );
    raw.scenes[0].actions[1].at = { mrak: "type-cube" };
    expect(() => parseLessonScript(raw)).toThrow(
      /scenes\.0\.actions\.1\.at: Unrecognized anchor key "mrak"/,
    );
  });

  it("rejects an anchor that names both a mark and an afterAction", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    raw.scenes[1].actions[3].at = { mark: "run", afterAction: "run" };
    expect(() => parseLessonScript(raw)).toThrow(/exactly one of scene, mark or afterAction/);
  });

  it("rejects unknown keys on the lesson, build, scene, and runtime blocks", () => {
    const cases: [string, (raw: Record<string, any>) => void][] = [
      ["(script)", (raw) => (raw.check = raw.checks)],
      ["lesson", (raw) => (raw.lesson.titel = "x")],
      ["build", (raw) => (raw.build.sead = 1)],
      ["scenes.0", (raw) => (raw.scenes[0].chapters = "x")],
      ["runtime", (raw) => (raw.runtime.dockStartsColapsed = true)],
      ["lesson.workspace", (raw) => (raw.lesson.workspace.sidebarCollapsed = true)],
    ];
    for (const [path, mutate] of cases) {
      const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
      mutate(raw);
      expect(() => parseLessonScript(raw)).toThrow(
        new RegExp(`${path.replace(/[.()]/g, "\\$&")}: Unrecognized key`),
      );
    }

    const tour = YAML.parse(readFileSync(TOUR_PATH, "utf8"));
    tour.lesson.slides[0].maximised = true;
    expect(() => parseLessonScript(tour)).toThrow(
      /lesson\.slides\.0: Unrecognized key: "maximised"/,
    );
  });

  // The plan schema already rejects an apply that does nothing; without the
  // same rule here the script passed the CLI and Import and only failed at
  // compile time, after every dialog was synthesized.
  it("rejects a whiteboard.apply that changes nothing", () => {
    const raw = YAML.parse(readFileSync(TOUR_PATH, "utf8"));
    delete raw.scenes[1].actions[2].open;
    expect(() => parseLessonScript(raw)).toThrow(/whiteboard\.apply must open\/close/);
  });

  // The Worker and Modal synthesizers reject anything above a signed 32-bit int.
  it("caps build.seed at the synthesizers' 32-bit limit", () => {
    const raw = YAML.parse(readFileSync(PILOT_PATH, "utf8"));
    raw.build.seed = 0x7fffffff;
    expect(parseLessonScript(raw).build.seed).toBe(0x7fffffff);
    raw.build.seed = 0x80000000;
    expect(() => parseLessonScript(raw)).toThrow(/build\.seed: must be at most 2147483647/);
  });
});
