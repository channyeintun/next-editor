import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { ActionReceipt, StudioCheckResult, StudioRenderReport } from "./report";
import { CheckList, ReceiptList, RepeatabilityVerdict } from "./StudioRunResults";

function receipt(overrides: Partial<ActionReceipt>): ActionReceipt {
  return {
    actionId: "scene.1.type",
    actionType: "editor.type",
    status: "ok",
    plannedAtMs: 1_000,
    startedAtMs: 1_012.4,
    endedAtMs: 1_500,
    ...overrides,
  };
}

function report(overrides: Partial<StudioRenderReport>): StudioRenderReport {
  return {
    outcome: "failed",
    planSlug: "demo",
    runtimeMode: "fixture",
    startedAtIso: "2026-01-01T00:00:00.000Z",
    wallDurationMs: 1,
    recordingDurationMs: 1,
    receipts: [],
    timing: null,
    checks: [],
    errors: [],
    ...overrides,
  };
}

describe("ReceiptList", () => {
  it("marks each action's status and how far its start drifted from the plan", () => {
    render(
      <ReceiptList
        receipts={[
          receipt({}),
          receipt({ actionId: "run", status: "failed", startedAtMs: 1_990.6, plannedAtMs: 2_000 }),
          receipt({ actionId: "never", status: "skipped", startedAtMs: null }),
        ]}
      />,
    );

    const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual(["✓scene.1.type1012ms (+12)", "✗run1991ms (+-9)", "–never—"]);
    // Secondary text keeps 4.5:1 on the console panel (slate-400, 7.20:1).
    expect(screen.getByText("1012ms (+12)")).toHaveClass("text-slate-400");
    expect(screen.getByText("–")).toHaveClass("text-slate-400");
  });

  it("lists failed actions with their error and any diagnostic screenshot", () => {
    render(
      <ReceiptList
        receipts={[
          receipt({}),
          receipt({
            actionId: "preview.open",
            status: "failed",
            error: "Frame never loaded",
            detail: { diagnosticScreenshot: { dataUrl: "data:image/png;base64,AAAA" } },
          }),
          receipt({
            actionId: "run",
            status: "failed",
            error: "Timed out",
            detail: { diagnosticScreenshot: { dataUrl: 7 } },
          }),
        ]}
      />,
    );

    expect(screen.getByText("preview.open: Frame never loaded")).toBeInTheDocument();
    expect(screen.getByText("run: Timed out")).toBeInTheDocument();
    expect(screen.getAllByRole("img").map((image) => image.getAttribute("alt"))).toEqual([
      "Preview diagnostic for preview.open",
    ]);
  });
});

describe("CheckList", () => {
  it("counts the passing checks, shows the p95 timing, and lists page errors", () => {
    render(
      <CheckList
        report={report({
          timing: { samples: 3, p50Ms: 4, p95Ms: 12, maxMs: 20 },
          checks: [
            { id: "timing", ok: true, detail: "within budget" },
            { id: "captions", ok: false, detail: "2 cues missing" },
          ],
          errors: ["Uncaught TypeError: x"],
        })}
      />,
    );

    expect(screen.getByRole("heading")).toHaveTextContent("Checks (1/2 ok · p95 12ms)");
    expect(screen.getByText("(1/2 ok · p95 12ms)")).toHaveClass("text-slate-400");
    expect(screen.getByText("within budget", { exact: false })).toHaveClass("text-slate-400");
    expect(screen.getByText("2 cues missing", { exact: false })).toHaveClass("text-rose-300");
    expect(screen.getByText("Uncaught TypeError: x")).toBeInTheDocument();
  });

  it("shows a check's preview screenshot, or why there is none", () => {
    render(
      <CheckList
        report={report({
          checks: [
            {
              id: "preview",
              ok: false,
              detail: "route differs",
              diagnostic: {
                previewScreenshot: { dataUrl: "data:image/png;base64,BBBB", width: 1, height: 1 },
              },
            },
            {
              id: "preview-2",
              ok: false,
              detail: "no frame",
              diagnostic: { previewScreenshot: { error: "bridge gone" } },
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("heading")).toHaveTextContent("Checks (0/2 ok)");
    expect(screen.getByRole("img", { name: "Preview diagnostic for preview" })).toHaveAttribute(
      "src",
      "data:image/png;base64,BBBB",
    );
    expect(screen.getByText("Screenshot: bridge gone")).toBeInTheDocument();
  });
});

describe("RepeatabilityVerdict", () => {
  const same: StudioCheckResult = { id: "workspace", ok: true, detail: "same final files" };
  const differs: StudioCheckResult = { id: "audio", ok: false, detail: "hash differs" };

  it("passes only when every check matched", () => {
    const { rerender } = render(<RepeatabilityVerdict checks={[same]} />);
    expect(screen.getByText("PASS")).toHaveClass("text-emerald-400");

    rerender(<RepeatabilityVerdict checks={[same, differs]} />);
    expect(screen.getByText("FAIL")).toHaveClass("text-rose-400");
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "✓ workspace — same final files",
      "✗ audio — hash differs",
    ]);
  });
});
