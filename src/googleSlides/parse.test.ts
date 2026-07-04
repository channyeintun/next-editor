import { describe, expect, it } from "vitest";
import fixtureHtml from "./__fixtures__/published-deck.html?raw";
import { isPublishedDeckUrl, parsePublishedDeck } from "./parse";
import { normalizeSvg } from "./normalizeSvg";
import { GoogleSlidesParseError } from "./types";

const SOURCE_URL = "https://docs.google.com/presentation/d/e/TOKEN/pub";

describe("isPublishedDeckUrl", () => {
  it.each([
    ["https://docs.google.com/presentation/d/e/2PACX-abc/pub", true],
    ["https://docs.google.com/presentation/d/e/2PACX-abc/pub?start=false", true],
    ["https://docs.google.com/presentation/d/e/2PACX-abc/embed", true],
    ["https://docs.google.com/presentation/d/1AbCdEf/edit", false],
    ["https://docs.google.com/presentation/d/1AbCdEf/edit#slide=id.p", false],
    ["https://example.com/presentation/d/e/x/pub", false],
    ["not a url", false],
  ])("%s -> %s", (url, expected) => {
    expect(isPublishedDeckUrl(url)).toBe(expected);
  });
});

describe("parsePublishedDeck", () => {
  const deck = parsePublishedDeck(fixtureHtml, SOURCE_URL);

  it("reads deck dimensions and source url", () => {
    expect(deck.sourceUrl).toBe(SOURCE_URL);
    expect(deck.width).toBe(960);
    expect(deck.height).toBe(540);
  });

  it("extracts one slide per page id in order", () => {
    expect(deck.slides.map((s) => s.pageId)).toEqual(["g_slide1", "g_slide2"]);
    expect(deck.slides.map((s) => s.title)).toEqual(["Intro", "Details"]);
  });

  it("keeps each slide's SVG markup", () => {
    expect(deck.slides[0].svg.startsWith("<svg")).toBe(true);
    expect(deck.slides[0].svg).toContain('viewBox="0.0 0.0 960.0 540.0"');
    expect(deck.slides[0].svg).toContain('id="el1"');
    expect(deck.slides[1].svg).toContain('id="s2a"');
  });

  it("converts build steps, applying skip rules", () => {
    const steps = deck.slides[0].steps;
    expect(steps).toHaveLength(2);

    // Step 1: single opacity reveal of el1.
    expect(steps[0]).toEqual([
      {
        elementId: "el1",
        durationMs: 500,
        delayMs: 0,
        tracks: [{ kind: "opacity", from: 0, to: 1 }],
      },
    ]);

    // Step 2: el2 with opacity + scale + translate. The page-id entry and the
    // flag===2 entry (el3) are dropped.
    expect(steps[1]).toEqual([
      {
        elementId: "el2",
        durationMs: 400,
        delayMs: 100,
        tracks: [
          { kind: "opacity", from: 0, to: 1 },
          { kind: "scale", from: 0.5, to: 1 },
          { kind: "translate", fromX: 0, fromY: 0.1, toX: 0, toY: 0 },
        ],
      },
    ]);
  });

  it("yields empty steps for a slide without animations", () => {
    expect(deck.slides[1].steps).toEqual([]);
  });
});

describe("parsePublishedDeck error paths", () => {
  it("throws when docData is missing", () => {
    expect(() => parsePublishedDeck("<html><body>nothing</body></html>", SOURCE_URL)).toThrow(
      GoogleSlidesParseError,
    );
  });

  it("throws when the page-id and SVG counts disagree", () => {
    const broken = fixtureHtml.replace("SK_svgData = '", "SK_svgDataX = '");
    expect(() => parsePublishedDeck(broken, SOURCE_URL)).toThrow(GoogleSlidesParseError);
  });

  it("decodes literal backslashes in slide content without corruption", () => {
    // A text run containing a\b (a, backslash, b): Google encodes the backslash
    // as \x5c. A naive "decode \xNN then JSON.parse" would misread \ + b as a
    // backspace escape; the single-pass decoder must preserve the backslash.
    const html =
      '<script>docData: [[10,20],[["p",null,"T",null,null,null,null,[[]]]]]</script>' +
      "<script>setPageData('p');SK_svgData = '\\x3csvg\\x3e\\x3ctext\\x3ea\\x5cb\\x3c/text\\x3e\\x3c/svg\\x3e';</script>";
    const d = parsePublishedDeck(html, SOURCE_URL);
    expect(d.slides[0].svg).toBe("<svg><text>a\\b</text></svg>");
  });

  it("keeps a step whose surviving entries are all flag===2 as an empty step, but drops a step whose entries are all page-id-targeted", () => {
    // Slide "p" has three steps:
    //  - step A: one entry targeting the page id itself -> zero surviving
    //    entries after the page-id filter -> dropped entirely.
    //  - step B: one page-id entry (excluded) plus one flag===2 entry on a
    //    real element -> one surviving entry at the page-id stage, so the
    //    step is kept, but the flag===2 entry produces no track -> kept as [].
    //  - step C: a normal opacity entry -> kept with one entry, to prove
    //    numbering continues correctly after the empty step.
    const stepA = [[[[[0, 0, 1]], "p", 100, 0, 0, 0, 0]]];
    const stepB = [
      [
        [[[0, 0, 1]], "p", 100, 0, 0, 0, 0],
        [[[0, 0, 1]], "el1", 100, 0, 0, 0, 2],
      ],
    ];
    const stepC = [[[[[0, 0, 1]], "el2", 200, 0, 0, 0, 0]]];
    const rawSteps = [stepA, stepB, stepC];
    const docData = [[10, 20], [["p", null, "T", null, null, null, null, [rawSteps]]]];
    const html =
      `<script>docData: ${JSON.stringify(docData)}</script>` +
      "<script>setPageData('p');SK_svgData = '\\x3csvg\\x3e\\x3c/svg\\x3e';</script>";
    const d = parsePublishedDeck(html, SOURCE_URL);
    expect(d.slides[0].steps).toHaveLength(2);
    expect(d.slides[0].steps[0]).toEqual([]); // step B: kept, empty
    expect(d.slides[0].steps[1]).toEqual([
      {
        elementId: "el2",
        durationMs: 200,
        delayMs: 0,
        tracks: [{ kind: "opacity", from: 0, to: 1 }],
      },
    ]); // step C
  });

  it("bracket-matches docData even with nested arrays", () => {
    // Sanity: the fixture's docData is itself deeply nested, and it parsed
    // above; here we assert a minimal nested case too.
    const html =
      '<script>docData: [[10,20],[["p",null,"T",null,null,null,null,[[]]]]]</script>' +
      "<script>setPageData('p');SK_svgData = '\\x3csvg\\x3e\\x3c/svg\\x3e';</script>";
    const d = parsePublishedDeck(html, SOURCE_URL);
    expect(d.width).toBe(10);
    expect(d.slides).toHaveLength(1);
    expect(d.slides[0].svg).toBe("<svg></svg>");
  });
});

describe("normalizeSvg", () => {
  it("strips tabindex attributes", () => {
    expect(normalizeSvg('<g id="a" tabindex="0"><rect tabindex="-1"/></g>')).toBe(
      '<g id="a"><rect/></g>',
    );
  });

  it("unwraps google redirect hrefs and leaves other urls alone", () => {
    const svg =
      '<a xlink:href="https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fx&sa=D">' +
      '<image xlink:href="https://docs.google.com/img.png"/></a>';
    const out = normalizeSvg(svg);
    expect(out).toContain('xlink:href="https://example.com/x"');
    expect(out).toContain('xlink:href="https://docs.google.com/img.png"');
  });

  it("leaves data URIs untouched", () => {
    const svg = '<image xlink:href="data:image/png;base64,AAAA"/>';
    expect(normalizeSvg(svg)).toBe(svg);
  });

  it("removes script elements and inline event handlers", () => {
    const svg = '<svg onload="evil()"><script>bad()</script><rect onclick="x()"/></svg>';
    const out = normalizeSvg(svg);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onload");
    expect(out).not.toContain("onclick");
  });
});
