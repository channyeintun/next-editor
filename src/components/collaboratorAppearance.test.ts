import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { collaborationParticipantColorIndex } from "../collaboration/relativePosition";
import {
  COLLABORATOR_DOT_CLASSES,
  collaboratorColor,
  collaboratorDisplayName,
  collaboratorSelectionColor,
} from "./collaboratorAppearance";

// collaborationParticipantColorIndex hashes every participant into this many slots.
const COLOR_COUNT = 8;
const COLOR_INDEXES = Array.from({ length: COLOR_COUNT }, (_, index) => index);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("collaboratorDisplayName", () => {
  it("shows the account name without surrounding whitespace", () => {
    expect(collaboratorDisplayName({ name: "  Ada Lovelace ", username: "ada" })).toBe(
      "Ada Lovelace",
    );
  });

  it("falls back to the username when the name is missing or blank", () => {
    expect(collaboratorDisplayName({ name: null, username: "ada" })).toBe("ada");
    expect(collaboratorDisplayName({ name: "", username: "ada" })).toBe("ada");
    expect(collaboratorDisplayName({ name: "   ", username: "ada" })).toBe("ada");
  });
});

describe("collaborator colours", () => {
  it("has a distinct colour for every colour index a participant can get", () => {
    const participant = {
      actorId: "20000000-0000-4000-8000-000000000001",
      sessionId: "30000000-0000-4000-8000-000000000001",
    };
    expect(collaborationParticipantColorIndex(participant)).toBeLessThan(COLOR_COUNT);

    expect(new Set(COLOR_INDEXES.map(collaboratorColor)).size).toBe(COLOR_COUNT);
    expect(new Set(COLOR_INDEXES.map(collaboratorSelectionColor)).size).toBe(COLOR_COUNT);
    expect(new Set(COLLABORATOR_DOT_CLASSES).size).toBe(COLOR_COUNT);
  });

  it("falls back to the first colour for an index outside the list", () => {
    expect(collaboratorColor(COLOR_COUNT)).toBe(collaboratorColor(0));
    expect(collaboratorSelectionColor(-1)).toBe(collaboratorSelectionColor(0));
  });

  it("highlights a selection in the collaborator's colour at 28% opacity", () => {
    for (const index of COLOR_INDEXES) {
      const [red, green, blue] = [1, 3, 5].map((start) =>
        Number.parseInt(collaboratorColor(index).slice(start, start + 2), 16),
      );
      expect(collaboratorSelectionColor(index)).toBe(`rgb(${red} ${green} ${blue} / 28%)`);
    }
  });

  it("matches the colours App.css gives the cursors CodeEditor draws", () => {
    const css = readFileSync(resolve("src/App.css"), "utf8");
    const rule = (selector: string, declaration: string) =>
      new RegExp(`${escapeRegExp(selector)}\\s*\\{\\s*${escapeRegExp(declaration)};\\s*\\}`);

    for (const index of COLOR_INDEXES) {
      expect(css).toMatch(
        rule(
          `.monaco-editor .collaboration-color-${index}`,
          `--collaboration-color: ${collaboratorColor(index)}`,
        ),
      );
      expect(css).toMatch(
        rule(
          `.monaco-editor .collaboration-selection.collaboration-color-${index}`,
          `background: ${collaboratorSelectionColor(index)}`,
        ),
      );
    }
  });
});
