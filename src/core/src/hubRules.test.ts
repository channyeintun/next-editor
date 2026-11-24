// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  WHERE_A_BODY_BELONGS,
  functionLengths,
  inlineUnionMembers,
  linesOutsideMachine,
  longFunctionProblems,
  machineHelperProblems,
  machineTypeProblems,
  typeDeclarationCount,
} from "./hubRules";

/**
 * Hubs wire, owners implement (CLAUDE.md). Every domain converges on editorMachine.ts
 * and machine/types.ts, so a body written there is a body every parallel change has to
 * read around, and the domain it belongs to no longer holds all of its own logic.
 * Machine structure (states, transitions, one-line registrations) stays free. What is
 * measured: in editorMachine.ts, a function over 10 lines of code, the lines of the
 * functions outside the machine, and any type declared there; in machine/types.ts, the
 * number of top-level types and an event type written inline in the event union.
 *
 * These rules measure only those two files. The other hubs CLAUDE.md names are left to
 * review: frameCapture.ts and frameReplay.ts are mostly the frames track's own body, and
 * useNextEditor.ts only adds one-statement senders, so a line cap would not fit them.
 */
const MACHINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "machine");
const EDITOR_MACHINE = readFileSync(join(MACHINE_DIR, "editorMachine.ts"), "utf8");
const MACHINE_TYPES = readFileSync(join(MACHINE_DIR, "types.ts"), "utf8");

/**
 * The functions in editorMachine.ts whose body is longer today, each with the most lines
 * it may keep. It may only shrink: shorten one or move it to its owner, then lower or
 * remove its entry.
 */
const LONG_FUNCTIONS: Record<string, number> = {
  syncStreamedRecordingGrowth: 14,
};

/**
 * The lines of code in functions of editorMachine.ts outside the machine itself
 * (isEventForLoadedRecording today). It may only go down: a helper split into short
 * siblings passes the cap above, but not this.
 */
const MACHINE_HELPER_LINES = 10;

/**
 * How many top-level interface and type declarations machine/types.ts holds. It may
 * only go down: a new domain declares its events and its context slice in its own
 * module and types.ts imports them, as it does from learnerWorkspace.ts and
 * viewerPanels.ts.
 */
const MACHINE_TYPE_DECLARATIONS = 47;

describe("hub rules", () => {
  it("measures a function's body in lines of code, not comments or blank lines", () => {
    const body = Array.from({ length: 10 }, (_, index) => `  const step${index} = ${index};`);
    const source = [
      "function twelve() {",
      ...body,
      "}",
      "const commented = () => {",
      "  // one",
      "",
      "  /* two",
      "     three */",
      "  return 1;",
      "};",
      "const machine = setup({",
      "  actions: { short: assign(({ context }) => ({ value: context.value })) },",
      "});",
    ].join("\n");

    expect(functionLengths(source)).toEqual([
      { name: "twelve", line: 1, lines: 12 },
      { name: "commented", line: 13, lines: 3 },
      { name: "short", line: 21, lines: 1 },
    ]);
  });

  it("flags a new long function, a listed one that grew, and a list that should shrink", () => {
    const longArrow = (name: string, statements: number) =>
      [
        `const ${name} = () => {`,
        ...Array.from({ length: statements }, (_, index) => `  call(${index});`),
        "};",
      ].join("\n");
    const source = [longArrow("added", 10), longArrow("listed", 11), longArrow("shortened", 8)];

    expect(
      longFunctionProblems(source.join("\n"), { listed: 14, shortened: 12, removed: 20 }),
    ).toEqual([
      `added (line 1) is 12 lines; ${WHERE_A_BODY_BELONGS}`,
      "listed is now 13 lines; lower its entry in LONG_FUNCTIONS (hubRules.test.ts) to 13",
      "shortened is now 10 lines or fewer, or is gone; remove it from LONG_FUNCTIONS (hubRules.test.ts)",
      "removed is now 10 lines or fewer, or is gone; remove it from LONG_FUNCTIONS (hubRules.test.ts)",
    ]);
    expect(longFunctionProblems(longArrow("listed", 11), { listed: 12 })).toEqual([
      `listed (line 1) grew to 13 lines (listed at 12); ${WHERE_A_BODY_BELONGS}`,
    ]);
  });

  it("measures class methods, accessors and fields that hold a function", () => {
    const body = (statements: number) =>
      Array.from({ length: statements }, (_, index) => `    call(${index});`);
    const source = [
      "class Holder {",
      "  method() {",
      ...body(2),
      "  }",
      "  get value() {",
      "    return 1;",
      "  }",
      "  #hidden() {",
      "    return 2;",
      "  }",
      "  field = () => {",
      "    return 3;",
      "  };",
      "}",
    ].join("\n");

    expect(functionLengths(source)).toEqual([
      { name: "method", line: 2, lines: 4 },
      { name: "value", line: 6, lines: 3 },
      { name: "#hidden", line: 9, lines: 3 },
      { name: "field", line: 12, lines: 3 },
    ]);
  });

  it("counts the helpers outside the machine, so a body split into short ones is caught", () => {
    const helper = (name: string) =>
      [
        `function ${name}() {`,
        ...Array.from({ length: 8 }, (_, index) => `  call(${index});`),
        "}",
      ].join("\n");
    const source = [
      helper("one"),
      "export const editorMachine = setup({",
      "  actions: { short: assign(({ context }) => ({ value: context.value })) },",
      "}).createMachine({});",
      helper("two"),
      helper("three"),
    ].join("\n");

    expect(longFunctionProblems(source, {})).toEqual([]);
    expect(linesOutsideMachine(source, "editorMachine")).toBe(30);
    expect(machineHelperProblems(source, 10)).toEqual([
      "editorMachine.ts has 30 lines of code in functions outside the machine, more than 10: " +
        "write the helper in its domain's module and import it",
    ]);
    expect(machineHelperProblems(source, 40)).toEqual([
      "editorMachine.ts has 30 lines of code in functions outside the machine; lower " +
        "MACHINE_HELPER_LINES (hubRules.test.ts) to 30",
    ]);
    expect(machineHelperProblems(`type Foo = { a: 1 };\n${source}`, 30)).toEqual([
      "editorMachine.ts declares 1 top-level interface or type declarations: declare them in " +
        "the module of the domain they belong to and import them",
    ]);
  });

  it("flags an inline object type anywhere in the event union, and a changed declaration count", () => {
    const source = [
      'import type { OwnedEvent } from "./owner";',
      'export type NamedEvent = { type: "NAMED" };',
      "interface Context { value: number }",
      'type Grouped = NamedEvent | { type: "INLINE_IN_GROUP" };',
      "export type EditorMachineEvent =",
      "  | Grouped",
      "  | OwnedEvent",
      "  | (NamedEvent & { extra: true })",
      '  | { type: "INLINE" };',
    ].join("\n");

    expect(inlineUnionMembers(source, "EditorMachineEvent")).toEqual([4, 8, 9]);
    expect(typeDeclarationCount(source)).toBe(4);
    expect(machineTypeProblems(source, 3)[0]).toMatch(/has 4 top-level .* more than 3/);
    expect(machineTypeProblems(source, 5)[0]).toBe(
      "machine/types.ts has 4 top-level interface and type declarations; lower " +
        "MACHINE_TYPE_DECLARATIONS (hubRules.test.ts) to 4",
    );
  });

  it("keeps editorMachine.ts to wiring", () => {
    expect(longFunctionProblems(EDITOR_MACHINE, LONG_FUNCTIONS)).toEqual([]);
    expect(machineHelperProblems(EDITOR_MACHINE, MACHINE_HELPER_LINES)).toEqual([]);
  });

  it("keeps machine/types.ts to the types it already declares", () => {
    expect(machineTypeProblems(MACHINE_TYPES, MACHINE_TYPE_DECLARATIONS)).toEqual([]);
  });
});
