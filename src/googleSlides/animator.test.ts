import { afterEach, describe, expect, it } from "vitest";
import { DeckStepAnimator, buildTimeline, sampleStyles, timeForRevealed } from "./animator";
import type { DeckStep } from "./types";

afterEach(() => {
  document.body.innerHTML = "";
});

const steps: DeckStep[] = [
  // Step 0: fade el1 in over 400ms starting at 0.
  [
    {
      elementId: "el1",
      durationMs: 400,
      delayMs: 0,
      tracks: [{ kind: "opacity", from: 0, to: 1 }],
    },
  ],
  // Step 1: el2 opacity + scale, plus el3 translate delayed 100ms.
  [
    {
      elementId: "el2",
      durationMs: 200,
      delayMs: 0,
      tracks: [
        { kind: "opacity", from: 0, to: 1 },
        { kind: "scale", from: 0, to: 1 },
      ],
    },
    {
      elementId: "el3",
      durationMs: 200,
      delayMs: 100,
      tracks: [{ kind: "translate", fromX: 0, fromY: 1, toX: 0, toY: 0 }],
    },
  ],
];

describe("buildTimeline", () => {
  it("lays steps end to end and records step end times", () => {
    const tl = buildTimeline(steps);
    // Step 0 length = 400; step 1 length = max(0+200, 100+200) = 300.
    expect(tl.stepEndTimes).toEqual([400, 700]);
    expect(tl.total).toBe(700);
    const el3 = tl.entries.find((e) => e.entry.elementId === "el3");
    expect(el3).toMatchObject({ start: 500, end: 700 }); // 400 + delay 100 .. +200
  });
});

describe("timeForRevealed", () => {
  const tl = buildTimeline(steps);
  it("maps reveal counts to timeline positions", () => {
    expect(timeForRevealed(tl, 0)).toBe(0);
    expect(timeForRevealed(tl, 1)).toBe(400);
    expect(timeForRevealed(tl, 2)).toBe(700);
    expect(timeForRevealed(tl, 5)).toBe(700); // clamped
  });
});

describe("sampleStyles", () => {
  const tl = buildTimeline(steps);

  it("keeps everything hidden at t=0", () => {
    const s = sampleStyles(tl, 0);
    expect(s.get("el1")?.opacity).toBe(0);
    expect(s.get("el2")?.opacity).toBe(0);
  });

  it("interpolates opacity linearly at the midpoint", () => {
    const s = sampleStyles(tl, 200); // halfway through el1's 400ms fade
    expect(s.get("el1")?.opacity).toBeCloseTo(0.5, 5);
  });

  it("fully reveals step 0 at its end time", () => {
    const s = sampleStyles(tl, 400);
    expect(s.get("el1")?.opacity).toBe(1);
  });

  it("combines scale and translate into a single transform, opacity separate", () => {
    const s = sampleStyles(tl, 700); // fully revealed
    expect(s.get("el2")?.opacity).toBe(1);
    expect(s.get("el2")?.transform).toBe("scale(1)");
    // el3 ends at translate(0%, 0%).
    expect(s.get("el3")?.transform).toBe("translate(0%, 0%)");
  });

  it("eases scale/translate (not linear) mid-step", () => {
    const tl2 = buildTimeline([
      [
        {
          elementId: "x",
          durationMs: 100,
          delayMs: 0,
          tracks: [{ kind: "scale", from: 0, to: 1 }],
        },
      ],
    ]);
    const s = sampleStyles(tl2, 25); // 25% linear -> easeInOutCubic(0.25) = 0.0625
    expect(s.get("x")?.transform).toBe("scale(0.0625)");
  });
});

describe("DeckStepAnimator (snap path)", () => {
  function makeSvg(ids: string[]): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const id of ids) {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("id", id);
      svg.appendChild(g);
    }
    document.body.appendChild(svg);
    return svg;
  }

  it("hides fade-in targets on construction", () => {
    const svg = makeSvg(["el1", "el2", "el3"]);
    const a = new DeckStepAnimator(svg, steps);
    expect((svg.querySelector("#el1") as SVGElement).style.opacity).toBe("0");
    a.dispose();
  });

  it("snaps to full reveal on a multi-step jump", () => {
    const svg = makeSvg(["el1", "el2", "el3"]);
    const a = new DeckStepAnimator(svg, steps);
    a.setRevealed(2); // jump from 0 to 2 -> not a single forward step -> snaps
    expect((svg.querySelector("#el1") as SVGElement).style.opacity).toBe("1");
    expect((svg.querySelector("#el2") as SVGElement).style.opacity).toBe("1");
    a.dispose();
  });

  it("snaps backward without throwing", () => {
    const svg = makeSvg(["el1", "el2", "el3"]);
    const a = new DeckStepAnimator(svg, steps);
    a.setRevealed(2);
    a.setRevealed(0); // backward -> snap
    expect((svg.querySelector("#el1") as SVGElement).style.opacity).toBe("0");
    a.dispose();
  });

  it("ignores missing elements", () => {
    const svg = makeSvg(["el1"]); // el2/el3 absent
    const a = new DeckStepAnimator(svg, steps);
    expect(() => a.setRevealed(2)).not.toThrow();
    a.dispose();
  });
});
