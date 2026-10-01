import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createCaptionStore } from "./captionStore";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("captionStore", () => {
  it("remembers the picked track and its language", () => {
    createCaptionStore().trigger.selectTrack({ trackId: "auto-en-1", language: "en" });

    expect(window.localStorage.getItem("caption-track")).toBe("auto-en-1");
    expect(window.localStorage.getItem("caption-language")).toBe("en");
    expect(createCaptionStore().getSnapshot().context).toEqual({
      enabled: false,
      trackId: "auto-en-1",
      language: "en",
    });
  });

  // Saved before tracks were picked by id: the language still decides.
  it("keeps a language saved before tracks were picked by id", () => {
    window.localStorage.setItem("caption-enabled", "true");
    window.localStorage.setItem("caption-language", "my");

    expect(createCaptionStore().getSnapshot().context).toEqual({
      enabled: true,
      trackId: null,
      language: "my",
    });
  });
});
