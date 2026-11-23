// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEPS_OBJECT_HEADERS,
  DEPS_OBJECT_PATH_PREFIX,
  DEPS_OBJECT_REFUSAL_HEADERS,
  depsObjectIdOfPath,
  depsObjectKey,
  depsObjectPath,
  isDepsObjectId,
} from "./depsObjects";

const ID = "0123456789abcdef".repeat(4);

describe("deps object ids", () => {
  it("are exactly 64 lowercase hex digits", () => {
    expect(isDepsObjectId(ID)).toBe(true);
    expect(isDepsObjectId(ID.toUpperCase())).toBe(false);
    expect(isDepsObjectId(ID.slice(1))).toBe(false);
    expect(isDepsObjectId(`${ID}0`)).toBe(false);
    expect(isDepsObjectId(`${ID.slice(1)}g`)).toBe(false);
    expect(isDepsObjectId("")).toBe(false);
  });

  it("name one path and one bucket key", () => {
    expect(DEPS_OBJECT_PATH_PREFIX).toBe("/__webnode__/deps/");
    expect(depsObjectPath(ID)).toBe(`/__webnode__/deps/${ID}`);
    expect(depsObjectKey(ID)).toBe(`webnode-deps/${ID}`);
  });

  it("are read back only from exactly the prefix plus an id", () => {
    expect(depsObjectIdOfPath(depsObjectPath(ID))).toBe(ID);
    expect(depsObjectIdOfPath(`/__webnode__/deps/${ID}/`)).toBeNull();
    expect(depsObjectIdOfPath(`/__webnode__/deps/${ID}.br`)).toBeNull();
    expect(depsObjectIdOfPath(`/__webnode__/deps/x/${ID}`)).toBeNull();
    expect(depsObjectIdOfPath(`/__webnode__/deps/${ID.toUpperCase()}`)).toBeNull();
    expect(depsObjectIdOfPath("/__webnode__/deps/")).toBeNull();
    expect(depsObjectIdOfPath(`/deps/${ID}`)).toBeNull();
    expect(depsObjectIdOfPath(`//__webnode__/deps/${ID}`)).toBeNull();
  });
});

describe("deps object headers", () => {
  it("serve the stored Brotli bytes for good", () => {
    expect(DEPS_OBJECT_HEADERS).toEqual({
      "content-type": "application/octet-stream",
      "content-encoding": "br",
      "cache-control": "public, max-age=31536000, immutable, no-transform",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
      vary: "Accept-Encoding",
    });
    for (const name of Object.keys(DEPS_OBJECT_HEADERS)) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  it("keep no refusal", () => {
    expect(DEPS_OBJECT_REFUSAL_HEADERS).toEqual({ "cache-control": "no-store" });
  });

  it("cannot be changed by a host", () => {
    expect(Object.isFrozen(DEPS_OBJECT_HEADERS)).toBe(true);
    expect(Object.isFrozen(DEPS_OBJECT_REFUSAL_HEADERS)).toBe(true);
  });
});
