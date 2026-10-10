import { describe, expect, it } from "vite-plus/test";
import {
  previewCommandTarget,
  previewExpectationMismatches,
  type PreviewObservation,
} from "./previewExpectation";

const observed: PreviewObservation = {
  route: "/hello?name=Ada",
  target: {
    testId: "greeting",
    text: "Hello, Ada!",
    value: null,
    attributes: { "data-state": "ready" },
  },
};

describe("previewExpectationMismatches", () => {
  it("finds nothing when every authored field matches", () => {
    expect(
      previewExpectationMismatches(
        {
          route: "/hello?name=Ada",
          testId: "greeting",
          textContains: "Ada",
          attribute: { name: "data-state", value: "ready" },
        },
        observed,
      ),
    ).toEqual([]);
    // Nothing authored, nothing to miss.
    expect(previewExpectationMismatches({}, observed)).toEqual([]);
  });

  it("names each mismatch the way the render report shows it", () => {
    expect(previewExpectationMismatches({ route: "/" }, observed)).toEqual([
      'route is "/hello?name=Ada", expected "/"',
    ]);
    expect(previewExpectationMismatches({ testId: "farewell" }, observed)).toEqual([
      'target data-testid is "greeting", expected "farewell"',
    ]);
    expect(previewExpectationMismatches({ textContains: "Goodbye" }, observed)).toEqual([
      'target text does not contain "Goodbye"',
    ]);
    expect(previewExpectationMismatches({ value: "Ada" }, observed)).toEqual([
      'target value is null, expected "Ada"',
    ]);
    expect(
      previewExpectationMismatches({ attribute: { name: "data-state", value: "idle" } }, observed),
    ).toEqual(['target attribute "data-state" is "ready", expected "idle"']);
  });

  it("fails every target field when nothing was inspected", () => {
    expect(
      previewExpectationMismatches(
        {
          testId: "greeting",
          textContains: "Ada",
          value: "Ada",
          attribute: { name: "data-state", value: "ready" },
        },
        { route: "/" },
      ),
    ).toEqual([
      'target data-testid is undefined, expected "greeting"',
      'target text does not contain "Ada"',
      'target value is undefined, expected "Ada"',
      'target attribute "data-state" is undefined, expected "ready"',
    ]);
  });

  it("lists mismatches in a fixed order, route first", () => {
    expect(
      previewExpectationMismatches(
        {
          route: "/",
          testId: "farewell",
          textContains: "Goodbye",
          value: "Ada",
          attribute: { name: "data-state", value: "idle" },
        },
        observed,
      ).map((mismatch) => mismatch.split(" ").slice(0, 2).join(" ")),
    ).toEqual([
      "route is",
      "target data-testid",
      "target text",
      "target value",
      "target attribute",
    ]);
  });
});

describe("previewCommandTarget", () => {
  it("maps an authored test-id target onto the bridge's target", () => {
    expect(previewCommandTarget({ by: "testId", value: "greeting" })).toEqual({
      testId: "greeting",
    });
    expect(previewCommandTarget(undefined)).toBeUndefined();
  });
});
