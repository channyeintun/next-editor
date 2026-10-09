import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { copyTextToClipboard } from "./clipboard";

afterEach(() => {
  // Both are own properties added below; deleting them restores jsdom's defaults.
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
  document.body.replaceChildren();
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

/** Records each copy command with the textarea it ran against, then answers `result`. */
function stubExecCommand(result: boolean) {
  const copies: Array<{ command: string; text: string | undefined; readOnly: boolean }> = [];
  const execCommand = vi.fn<(command: string) => boolean>((command) => {
    const textarea = document.body.querySelector("textarea");
    copies.push({
      command,
      text: textarea?.value,
      readOnly: textarea?.hasAttribute("readonly") ?? false,
    });
    return result;
  });
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
  return { copies, execCommand };
}

describe("copyTextToClipboard", () => {
  it("writes through the Clipboard API when there is one", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    stubClipboard(writeText);
    const { execCommand } = stubExecCommand(true);

    await expect(copyTextToClipboard("/src/main.ts")).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("/src/main.ts");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("copies from an off-screen textarea where the Clipboard API is missing", async () => {
    const { copies } = stubExecCommand(true);

    await expect(copyTextToClipboard("src/main.ts")).resolves.toBe(true);

    expect(copies).toEqual([{ command: "copy", text: "src/main.ts", readOnly: true }]);
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("falls back to the textarea and returns its result when the Clipboard API refuses", async () => {
    stubClipboard(() =>
      Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")),
    );
    const { copies } = stubExecCommand(true);

    await expect(copyTextToClipboard("https://example.test/learn/a?t=60")).resolves.toBe(true);

    expect(copies).toEqual([
      { command: "copy", text: "https://example.test/learn/a?t=60", readOnly: true },
    ]);
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("returns false when both the Clipboard API and the copy command fail", async () => {
    stubClipboard(() => Promise.reject(new DOMException("Denied", "NotAllowedError")));
    stubExecCommand(false);

    await expect(copyTextToClipboard("lost")).resolves.toBe(false);
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("returns false, and removes the textarea, when there is no copy command", async () => {
    stubClipboard(() => Promise.reject(new DOMException("Denied", "NotAllowedError")));

    await expect(copyTextToClipboard("lost")).resolves.toBe(false);
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("gives focus back to the control that held it before the textarea took it", async () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    // Browsers focus a textarea when it is selected; jsdom does not, so the stub does.
    Object.defineProperty(document, "execCommand", {
      value: vi.fn<(command: string) => boolean>(() => {
        document.body.querySelector("textarea")?.focus();
        return true;
      }),
      configurable: true,
    });

    await expect(copyTextToClipboard("src/main.ts")).resolves.toBe(true);

    expect(document.activeElement).toBe(button);
  });
});
