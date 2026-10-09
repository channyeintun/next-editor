import { describe, expect, it } from "vite-plus/test";
import { parseGoPlaygroundFormatResult } from "./goPlayground/types";
import { isOptionalString, parsePlaygroundFormatResult } from "./playgroundContract";
import { parseRustPlaygroundFormatResult } from "./rustPlayground/types";
import { parseZigPlaygroundFormatResult } from "./zigPlayground/types";

describe("parsePlaygroundFormatResult", () => {
  it("accepts every formatted file and drops unknown fields", () => {
    expect(
      parsePlaygroundFormatResult({
        files: [
          { path: "main.go", content: "package main\n", extra: true },
          { path: "util.go", content: "" },
        ],
        surprise: "field",
      }),
    ).toStrictEqual({
      files: [
        { path: "main.go", content: "package main\n" },
        { path: "util.go", content: "" },
      ],
    });
  });

  it.each([
    ["null", null],
    ["a string", "files"],
    ["a missing file list", {}],
    ["a file list that is not an array", { files: { path: "main.go", content: "" } }],
    ["an empty file list", { files: [] }],
    ["a file that is not an object", { files: ["main.go"] }],
    ["a file with an empty path", { files: [{ path: "", content: "" }] }],
    ["a file with a non-string path", { files: [{ path: 1, content: "" }] }],
    ["a file with non-string content", { files: [{ path: "main.go", content: null }] }],
    [
      "the same path twice",
      {
        files: [
          { path: "main.go", content: "a" },
          { path: "main.go", content: "b" },
        ],
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(parsePlaygroundFormatResult(value)).toBeNull();
  });

  it("is the format parser Go, Rust and Zig share", () => {
    expect(parseGoPlaygroundFormatResult).toBe(parsePlaygroundFormatResult);
    expect(parseRustPlaygroundFormatResult).toBe(parsePlaygroundFormatResult);
    expect(parseZigPlaygroundFormatResult).toBe(parsePlaygroundFormatResult);
  });
});

describe("isOptionalString", () => {
  it("accepts a string or nothing, and nothing else", () => {
    expect(isOptionalString(undefined)).toBe(true);
    expect(isOptionalString("")).toBe(true);
    expect(isOptionalString(null)).toBe(false);
    expect(isOptionalString(0)).toBe(false);
  });
});
