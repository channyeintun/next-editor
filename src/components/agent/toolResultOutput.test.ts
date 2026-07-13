import { describe, expect, it } from "vitest";
import { formatToolResultOutput } from "./toolResultOutput";

describe("formatToolResultOutput", () => {
  it("renders JSON-encoded code with real newlines and tabs", () => {
    const code = '1\tfunction greet() {\n2\t\treturn "hello";\n3\t}';

    expect(formatToolResultOutput(JSON.stringify(code))).toBe(code);
  });

  it("leaves unencoded tool output intact", () => {
    expect(formatToolResultOutput("  exit code 0\nready  ")).toBe("exit code 0\nready");
  });

  it("does not alter serialized structured output", () => {
    const output = '{"status":"ok","lines":["one\\ntwo"]}';

    expect(formatToolResultOutput(output)).toBe(output);
  });
});
