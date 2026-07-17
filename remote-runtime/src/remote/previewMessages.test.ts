import { describe, expect, it } from "vitest";
import {
  matchesPreviewMessageSource,
  matchesPreviewOrigin,
  renderPreviewUrl,
} from "./RemoteContainer";
import {
  createPreviewErrorForwarder,
  isPreviewMessage,
  PreviewMessageType,
} from "./previewMessages";

describe("preview compatibility", () => {
  it("renders server-provided URL templates", () => {
    expect(renderPreviewUrl("https://p{{port}}-{{sessionId}}.preview.test", "abc", 8080)).toBe(
      "https://p8080-abc.preview.test",
    );
  });

  it("rejects malformed preview messages", () => {
    expect(isPreviewMessage({ type: PreviewMessageType.ConsoleError })).toBe(false);
    expect(
      isPreviewMessage({
        type: PreviewMessageType.ConsoleError,
        previewId: "p",
        port: 8080,
        pathname: "/",
        search: "",
        hash: "",
      }),
    ).toBe(false);
    expect(
      isPreviewMessage({
        type: PreviewMessageType.ConsoleError,
        previewId: "p",
        port: 8080,
        pathname: "/",
        search: "",
        hash: "",
        args: ["message"],
        stack: "stack",
      }),
    ).toBe(true);
  });

  it("validates the origin rendered for the message's actual preview port", () => {
    const template = "https://p{{port}}-{{sessionId}}.preview.test";
    expect(matchesPreviewOrigin(template, "abc", 8080, "https://p8080-abc.preview.test")).toBe(
      true,
    );
    expect(matchesPreviewOrigin(template, "abc", 8080, "https://p8600-abc.preview.test")).toBe(
      false,
    );
    expect(
      matchesPreviewMessageSource(
        template,
        "abc",
        { port: 8080, previewId: "another-session" },
        "https://p8080-abc.preview.test",
      ),
    ).toBe(false);
  });

  it("builds an origin-scoped error forwarder and honors exceptions-only mode", () => {
    const allErrors = createPreviewErrorForwarder({
      targetOrigin: "https://editor.test",
      previewId: "session-1",
      mode: true,
    });
    expect(allErrors).toContain("parent.postMessage");
    expect(allErrors).toContain('"https://editor.test"');
    expect(allErrors).toContain(PreviewMessageType.ConsoleError);

    const exceptionsOnly = createPreviewErrorForwarder({
      targetOrigin: "https://editor.test",
      previewId: "session-1",
      mode: "exceptions-only",
    });
    expect(exceptionsOnly).not.toContain(PreviewMessageType.ConsoleError);
    expect(exceptionsOnly).toContain(PreviewMessageType.UnhandledRejection);
  });
});
