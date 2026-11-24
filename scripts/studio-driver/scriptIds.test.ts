// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parsePublishedScriptIndex } from "../../src/studio/plans/publishedScripts.ts";
import { checkRenderedScripts } from "./scriptIds.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const entry = (id: string) => ({ id, bytes: 10, title: "T", locale: "en", runtimeMode: "fixture" });
const index = parsePublishedScriptIndex({
  version: 1,
  source: "abc123",
  lessons: { one: entry(A), two: entry(B) },
});

describe("checkRenderedScripts", () => {
  it("passes a site whose scripts are the local ones and names what is rendered", () => {
    expect(
      checkRenderedScripts({
        slugs: ["one"],
        index,
        localIds: new Map([["one", A]]),
        loopback: false,
        published: false,
      }),
    ).toEqual({ scripts: [{ slug: "one", id: A, source: "abc123", localId: A }] });
  });

  it("refuses a local script the site does not publish, saying to publish first", () => {
    const check = checkRenderedScripts({
      slugs: ["one", "two"],
      index,
      localIds: new Map([
        ["one", B],
        ["two", null],
      ]),
      loopback: false,
      published: false,
    });
    expect("refused" in check && check.refused).toEqual([
      expect.stringContaining("bun scripts/lesson-scripts.ts publish --remote"),
      expect.stringContaining("no script for it"),
    ]);
  });

  it("renders the published script when told to, recording that it is not the local one", () => {
    expect(
      checkRenderedScripts({
        slugs: ["one"],
        index,
        localIds: new Map([["one", B]]),
        loopback: false,
        published: true,
      }),
    ).toEqual({ scripts: [{ slug: "one", id: A, source: "abc123", localId: B }] });
  });

  it("does not refuse a difference on a dev server, which serves the working tree", () => {
    const check = checkRenderedScripts({
      slugs: ["one"],
      index,
      localIds: new Map([["one", B]]),
      loopback: true,
      published: false,
    });
    expect(check).toEqual({ scripts: [{ slug: "one", id: A, source: "abc123", localId: B }] });
  });

  it("refuses a lesson the index does not list, whatever the flags, without inherited names", () => {
    for (const slug of ["three", "constructor", "__proto__"]) {
      const check = checkRenderedScripts({
        slugs: [slug],
        index,
        localIds: new Map(),
        loopback: true,
        published: true,
      });
      expect(check).toEqual({ refused: [`${slug}: the site's lesson index does not list it`] });
    }
  });
});
