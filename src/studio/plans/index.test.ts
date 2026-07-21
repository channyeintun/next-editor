import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_STUDIO_PLAN_SLUG, STUDIO_SOURCES } from "./index";

describe("studio lesson registry", () => {
  it("auto-registers every emitted script by filename", () => {
    // The pilots must be present without any manual registry edit.
    for (const slug of ["go-cube", "go-cube-tour", "go-swap"]) {
      expect(STUDIO_SOURCES[slug]?.kind).toBe("script");
    }
    expect(STUDIO_SOURCES[DEFAULT_STUDIO_PLAN_SLUG]?.kind).toBe("plan");
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
