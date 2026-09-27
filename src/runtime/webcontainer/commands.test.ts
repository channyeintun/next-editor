import { describe, expect, it } from "vite-plus/test";
import { parseCommand } from "./commands";

describe("parseCommand", () => {
  it("delegates free-form runner commands to the sandbox shell", () => {
    const command = 'GREETING="hello world" printf "%s\\n" "$GREETING" | tee "out file.txt"';

    expect(parseCommand(command)).toEqual({ command: "sh", args: ["-lc", command] });
    expect(parseCommand("  \t\n ")).toBeNull();
  });

  it("preserves empty arguments, escaped spaces, operators, and Unicode whitespace", () => {
    const commands = [
      'printf "<%s>" ""',
      "printf %s escaped\\ space",
      "NAME=value sh -c 'printf %s \"$NAME\"' > output.txt",
      "printf 'left' && printf 'right'",
      "printf 'a\u2003b'",
    ];

    for (const command of commands) {
      expect(parseCommand(command)).toEqual({ command: "sh", args: ["-lc", command] });
    }
  });
});
