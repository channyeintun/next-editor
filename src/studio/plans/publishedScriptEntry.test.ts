import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  lessonFileNameProblem,
  lessonSlugOfFileName,
  publishedScriptFileOf,
} from "./publishedScriptEntry";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(__dirname, `../script/__fixtures__/${name}.yaml`)));

describe("publishedScriptFileOf", () => {
  it("names a script by the SHA-256 of its bytes and takes the facts the studio shows", async () => {
    const bytes = fixture("go-swap");
    const { entry, script } = await publishedScriptFileOf(bytes);
    expect(entry).toEqual({
      id: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      title: "Two return values, one swap",
      locale: "en-US",
      runtimeMode: "fixture",
    });
    expect(script.lesson.slug).toBe("go-swap");
  });

  it("takes the runtime mode a render uses when the URL names none", async () => {
    const { entry } = await publishedScriptFileOf(fixture("javascript-minimal"));
    expect(entry.runtimeMode).toBe("live");
  });

  it("refuses bytes that are not a LessonScript", async () => {
    await expect(publishedScriptFileOf(new TextEncoder().encode("lesson: 3\n"))).rejects.toThrow(
      /^Invalid lesson script: /,
    );
    await expect(publishedScriptFileOf(new Uint8Array([0xff, 0xfe, 0x00]))).rejects.toThrow(
      /not valid for encoding utf-8/,
    );
  });
});

describe("lesson file names", () => {
  it("reads the slug from <slug>.yaml only", () => {
    expect(lessonSlugOfFileName("rust-borrow.yaml")).toBe("rust-borrow");
    expect(lessonSlugOfFileName("rust-borrow.critique.json")).toBeNull();
    expect(lessonSlugOfFileName(".yaml")).toBeNull();
  });

  it("requires the file name to be the script's own slug", async () => {
    const { script } = await publishedScriptFileOf(fixture("go-swap"));
    expect(lessonFileNameProblem("go-swap.yaml", script.lesson.slug)).toBeNull();
    expect(lessonFileNameProblem("go-swap-2.yaml", script.lesson.slug)).toBe(
      'go-swap-2.yaml holds lesson.slug "go-swap"; the file must be go-swap.yaml',
    );
    expect(lessonFileNameProblem("go-swap.yml", script.lesson.slug)).toBe(
      "go-swap.yml is not named <slug>.yaml",
    );
  });
});
