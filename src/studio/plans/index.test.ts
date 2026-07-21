import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_STUDIO_PLAN_SLUG, STUDIO_SOURCES } from "./index";

describe("studio lesson registry", () => {
  it("registers exactly the checked-in scripts (rust-borrow only today)", () => {
    // Scripts auto-register by filename without any manual registry edit.
    expect(Object.keys(STUDIO_SOURCES).sort()).toEqual(["rust-borrow"]);
    expect(STUDIO_SOURCES[DEFAULT_STUDIO_PLAN_SLUG]?.kind).toBe("script");
  });

  it("never registers critic sidecars as lessons", () => {
    for (const slug of Object.keys(STUDIO_SOURCES)) {
      expect(slug).not.toContain(".critique");
    }
  });

  it("loads every registered source through its parser", () => {
    for (const [slug, source] of Object.entries(STUDIO_SOURCES)) {
      const lesson = source.load();
      // Script slugs come from filenames; the parsed content must agree.
      // (Plan-kind fixtures own their slug independently of the registry key.)
      expect(source.kind === "script" ? lesson.lesson.slug : slug).toBe(slug);
      expect(lesson.lesson.title.length).toBeGreaterThan(0);
      expect(["live", "fixture"]).toContain(
        lesson.runtime.kind === "none" ? "fixture" : lesson.runtime.defaultMode,
      );
    }
  });
});
