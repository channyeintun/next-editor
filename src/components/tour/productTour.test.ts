import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drive: vi.fn<() => void>(),
  driver: vi.fn<(options?: unknown) => { drive: () => void }>(),
}));

vi.mock("driver.js", () => ({ driver: mocks.driver }));

import { startTour } from "./productTour";

describe("product tour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.driver.mockReturnValue({ drive: mocks.drive });
    document.body.innerHTML = "";
  });

  it("introduces live collaboration before workspace settings", () => {
    document.body.innerHTML = `
      <button data-tour="collaboration">Live</button>
      <button data-tour="settings">Settings</button>
    `;

    startTour({ force: true });

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
});
