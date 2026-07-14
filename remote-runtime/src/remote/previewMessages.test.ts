import { describe, expect, it } from "vitest";
import { renderPreviewUrl } from "./RemoteContainer";
import { isPreviewMessage, PreviewMessageType } from "./previewMessages";

describe("preview compatibility", () => {
  it("renders server-provided URL templates", () => {
    expect(renderPreviewUrl("https://p{{port}}-{{sessionId}}.preview.test", "abc", 8080))
      .toBe("https://p8080-abc.preview.test");
  });

  it("rejects malformed preview messages", () => {
    expect(isPreviewMessage({ type: PreviewMessageType.ConsoleError })).toBe(false);
    expect(isPreviewMessage({
      type: PreviewMessageType.ConsoleError,
      previewId: "p",
      port: 8080,
      pathname: "/",
      search: "",
      hash: "",
    })).toBe(true);
  });
});
