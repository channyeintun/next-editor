import { describe, expect, it } from "vite-plus/test";
import { studioWhiteboardAssetSchema } from "./plan";
import { buildWhiteboardElement } from "./whiteboardAssets";

const RECT = studioWhiteboardAssetSchema.parse({
  id: "box",
  kind: "rectangle",
  x: 10,
  y: 20,
  width: 100,
  height: 50,
});

const TEXT = studioWhiteboardAssetSchema.parse({
  id: "label",
  kind: "text",
  x: 15,
  y: 25,
  width: 90,
  height: 30,
  text: "hello",
  fontSize: 24,
});

describe("buildWhiteboardElement", () => {
  it("is deterministic for the same plan seed", () => {
    expect(buildWhiteboardElement(RECT, 7)).toEqual(buildWhiteboardElement(RECT, 7));
  });

  it("varies seeds per asset and per plan seed", () => {
    const rect = buildWhiteboardElement(RECT, 7);
    const text = buildWhiteboardElement(TEXT, 7);
    const rectOtherPlan = buildWhiteboardElement(RECT, 8);
    expect(rect.seed).not.toBe(text.seed);
    expect(rect.seed).not.toBe(rectOtherPlan.seed);
  });

  it("produces render-ready Excalidraw fields", () => {
    const rect = buildWhiteboardElement(RECT, 7);
    expect(rect).toMatchObject({
      id: "box",
      type: "rectangle",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      version: 1,
      isDeleted: false,
    });
    expect(typeof rect.versionNonce).toBe("number");

    const text = buildWhiteboardElement(TEXT, 7);
    expect(text).toMatchObject({
      type: "text",
      text: "hello",
      originalText: "hello",
      fontSize: 24,
    });
  });
});
