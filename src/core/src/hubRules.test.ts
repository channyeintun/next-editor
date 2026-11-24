// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  WHERE_A_BODY_BELONGS,
  functionLengths,
  inlineUnionMembers,
  longFunctionProblems,
  machineTypeProblems,
  typeDeclarationCount,
} from "./hubRules";

/**
 * Hubs wire, owners implement (CLAUDE.md). Every domain converges on editorMachine.ts
 * and machine/types.ts, so a body written there is a body every parallel change has to
 * read around, and the domain it belongs to no longer holds all of its own logic.
 * Machine structure (states, transitions, one-line registrations) stays free; what
 * these checks stop is a domain's body or its types landing in the hub.
 *
 * frameCapture.ts and frameReplay.ts are the frames track's own modules, not hubs, and
 * useNextEditor.ts only adds one-statement senders, so neither gets a rule here.
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
  });

  it("keeps machine/types.ts to the types it already declares", () => {
    expect(machineTypeProblems(MACHINE_TYPES, MACHINE_TYPE_DECLARATIONS)).toEqual([]);
  });
});
