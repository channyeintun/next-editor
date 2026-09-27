import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { copyTextToClipboard } from "./clipboard";

afterEach(() => {
  // Both are own properties added below; deleting them restores jsdom's defaults.
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
});

describe("copyTextToClipboard", () => {
  it("writes through the Clipboard API when there is one", () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const execCommand = vi.fn<(command: string) => boolean>(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

    copyTextToClipboard("/src/main.ts");

    expect(writeText).toHaveBeenCalledWith("/src/main.ts");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("copies from an off-screen textarea where the Clipboard API is missing", () => {
    const copies: Array<{ command: string; text: string | undefined; readOnly: boolean }> = [];
    const execCommand = vi.fn<(command: string) => boolean>((command) => {
      const textarea = document.body.querySelector("textarea");
      copies.push({
        command,
        text: textarea?.value,
        readOnly: textarea?.hasAttribute("readonly") ?? false,
      });
      return true;
    });
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

    copyTextToClipboard("src/main.ts");

    expect(copies).toEqual([{ command: "copy", text: "src/main.ts", readOnly: true }]);
    expect(document.body.querySelector("textarea")).toBeNull();
  });
});
