import type { Slide } from "../types/slides";

// Fixtures the teaching document, slides and whiteboard tests share.

export const ASSET = {
  id: "a".repeat(64),
  mimeType: "application/vnd.next-editor.slide+json",
  size: 100,
};

export function slide(id: string, order: number, content = `<h1>${id}</h1>`): Slide {
  return { id, order, content, contentType: "html" };
}

export function element(id: string, version = 1, index = "a0") {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roundness: null,
    roughness: 1,
    opacity: 100,
    seed: 1,
    version,
    versionNonce: version * 10,
    index,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

export function freedraw(id: string, points: number[][]) {
  return {
    ...element(id),
    type: "freedraw",
    points,
    pressures: points.map(() => 0.5),
    simulatePressure: true,
    lastCommittedPoint: null,
  };
}
