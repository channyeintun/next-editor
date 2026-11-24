import { describe, expect, it } from "vite-plus/test";
import {
  encodePublishedScriptIndex,
  isPublishedScriptId,
  parsePublishedScriptIndex,
  publishedScriptIdOfPath,
  publishedScriptObjectPath,
} from "./publishedScripts";

const ID = "0123456789abcdef".repeat(4);

function entry(patch: Record<string, unknown> = {}) {
  return {
    id: ID,
    bytes: 120,
    title: "Error values",
    locale: "en-US",
    runtimeMode: "live",
    ...patch,
  };
}

function indexText(lessons: string, patch = ""): unknown {
  return JSON.parse(`{"version":1,"source":"abc123",${patch}"lessons":${lessons}}`);
}

describe("parsePublishedScriptIndex", () => {
  it("reads a valid index", () => {
    const index = parsePublishedScriptIndex(
      indexText(JSON.stringify({ "go-error-values": entry() })),
    );
    expect(index.source).toBe("abc123");
    expect(index.lessons["go-error-values"]).toEqual(entry());
  });

  it("refuses an entry whose id is not a script id", () => {
    for (const id of ["", "ABC", ID.toUpperCase(), `${ID}0`, ID.slice(1), "../index.json"]) {
      expect(() =>
        parsePublishedScriptIndex(indexText(JSON.stringify({ lesson: entry({ id }) }))),
      ).toThrow(/"lesson" has no script id/);
    }
  });

  it("refuses an index of another version", () => {
    expect(() => parsePublishedScriptIndex({ version: 2, source: "abc123", lessons: {} })).toThrow(
      /version 2; this studio reads version 1/,
    );
  });

  it("refuses an entry without the facts the studio shows", () => {
    expect(() =>
      parsePublishedScriptIndex(indexText(JSON.stringify({ a: entry({ runtimeMode: "x" }) }))),
    ).toThrow(/"a" has no runtime mode/);
    expect(() =>
      parsePublishedScriptIndex(indexText(JSON.stringify({ a: entry({ locale: "" }) }))),
    ).toThrow(/"a" has no locale/);
  });

  // `?plan=` indexes the record straight from the URL.
  it("keeps every slug in a record without a prototype", () => {
    // JSON.parse makes "__proto__" an own key, as a hostile index would hold it.
    const index = parsePublishedScriptIndex(
      indexText(`{"__proto__":${JSON.stringify(entry())},"a":${JSON.stringify(entry())}}`),
    );
    expect(Object.getPrototypeOf(index.lessons)).toBeNull();
    expect(Object.keys(index.lessons).sort()).toEqual(["__proto__", "a"]);
    expect(index.lessons.__proto__).toEqual(entry());
    for (const slug of ["constructor", "toString", "hasOwnProperty"]) {
      expect(index.lessons[slug]).toBeUndefined();
    }
  });

  it("reads back what it encodes", () => {
    const index = parsePublishedScriptIndex(
      indexText(JSON.stringify({ b: entry(), a: entry({ title: "A" }) })),
    );
    const text = encodePublishedScriptIndex(index);
    expect(Object.keys(JSON.parse(text).lessons)).toEqual(["a", "b"]);
    expect(parsePublishedScriptIndex(JSON.parse(text))).toEqual(index);
  });
});

describe("script object paths", () => {
  it("round-trips an id and refuses anything else", () => {
    expect(isPublishedScriptId(ID)).toBe(true);
    expect(publishedScriptIdOfPath(publishedScriptObjectPath(ID))).toBe(ID);
    expect(publishedScriptIdOfPath(publishedScriptObjectPath(""))).toBeNull();
    expect(publishedScriptIdOfPath(publishedScriptObjectPath(`${ID}/x`))).toBeNull();
    expect(publishedScriptIdOfPath("/api/studio/scripts/index")).toBeNull();
  });
});
