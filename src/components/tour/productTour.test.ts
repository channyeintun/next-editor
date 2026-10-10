import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  drive: vi.fn<() => void>(),
  driver: vi.fn<(options?: unknown) => { drive: () => void; isActive: () => boolean }>(),
}));

vi.mock("driver.js", () => ({ driver: mocks.driver }));

import { isProductTourActive, startTour } from "./productTour";

describe("product tour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.driver.mockReturnValue({ drive: mocks.drive, isActive: () => true });
    document.body.innerHTML = "";
  });

  it("introduces live collaboration before workspace settings", async () => {
    document.body.innerHTML = `
      <button data-tour="collaboration">Live</button>
      <button data-tour="settings">Settings</button>
    `;

    await startTour({ force: true });

    const options = mocks.driver.mock.calls[0][0] as {
      steps: Array<{ element: string; popover?: { title?: string } }>;
    };
    expect(options.steps).toMatchObject([
      {
        element: '[data-tour="collaboration"]',
        popover: { title: "Live collaboration" },
      },
      {
        element: '[data-tour="settings"]',
        popover: { title: "Settings" },
      },
    ]);
    expect(mocks.drive).toHaveBeenCalledOnce();
  });

  it("reports a tour on screen until it is destroyed", async () => {
    document.body.innerHTML = '<button data-tour="record">Record</button>';

    await startTour({ force: true });
    expect(isProductTourActive()).toBe(true);

    const { onDestroyed } = mocks.driver.mock.calls[0][0] as { onDestroyed: () => void };
    onDestroyed();
    expect(isProductTourActive()).toBe(false);
  });

  describe("the Agent step", () => {
    type AgentStep = {
      element: string;
      popover: {
        onNextClick: (
          element: Element | undefined,
          step: unknown,
          options: { driver: { moveNext: () => void } },
        ) => void;
      };
    };

    async function advancePastAgentStep(dockExpanded: boolean) {
      document.body.innerHTML = `
        <button data-tour="agent">Agent</button>
        <button data-runtime-dock-toggle aria-label="Runtime dock" aria-expanded="${dockExpanded}"></button>
      `;
      const agentTab = document.querySelector<HTMLElement>('[data-tour="agent"]')!;
      const dockToggle = document.querySelector<HTMLElement>("[data-runtime-dock-toggle]")!;
      const clicks: string[] = [];
      agentTab.addEventListener("click", () => clicks.push("agent"));
      dockToggle.addEventListener("click", () => clicks.push("dock"));

      await startTour({ force: true });
      const { steps } = mocks.driver.mock.calls[0][0] as { steps: AgentStep[] };
      const agentStep = steps.find((step) => step.element === '[data-tour="agent"]')!;
      agentStep.popover.onNextClick(agentTab, agentStep, { driver: { moveNext: () => {} } });
      return clicks;
    }

    it("opens the Agent tab and expands a collapsed dock of either kind", async () => {
      expect(await advancePastAgentStep(false)).toEqual(["agent", "dock"]);
    });

    it("leaves an open dock open", async () => {
      expect(await advancePastAgentStep(true)).toEqual(["agent"]);
    });
  });
});
