import { describe, expect, it } from "vitest";
import {
  ARTIFACT_EXTENSION,
  COMMANDS,
  CONTEXT_KEYS,
  COMMAND_NAMESPACE,
  EXTENSION_ID,
  PLAYER_VIEW_TYPE,
  newDocumentId,
  newSessionId,
} from "../../src/model/ids";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("identifiers", () => {
  it("generates opaque UUID identifiers", () => {
    expect(newSessionId()).toMatch(UUID_PATTERN);
    expect(newDocumentId()).toMatch(UUID_PATTERN);
    expect(newSessionId()).not.toEqual(newSessionId());
  });

  it("keeps branding centralized and consistent", () => {
    expect(EXTENSION_ID.endsWith(".next-recording")).toBe(true);
    expect(PLAYER_VIEW_TYPE).toBe(`${COMMAND_NAMESPACE}.player`);
    expect(ARTIFACT_EXTENSION).toBe(".nextrecording");
    for (const command of Object.values(COMMANDS)) {
      expect(command.startsWith(`${COMMAND_NAMESPACE}.`)).toBe(true);
    }
    for (const key of Object.values(CONTEXT_KEYS)) {
      expect(key.startsWith(`${COMMAND_NAMESPACE}.`)).toBe(true);
    }
  });
});
