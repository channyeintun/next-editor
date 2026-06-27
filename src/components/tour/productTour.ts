import { driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";

const TOUR_SEEN_KEY = "next-editor.tour.v1.seen";

const TOUR_STEPS: Array<DriveStep & { element: string }> = [
  {
    element: '[data-tour="record"]',
    popover: {
      title: "Record",
      description: "Click here to start (or stop) recording your coding session.",
    },
  },
  {
    element: '[data-tour="settings"]',
    popover: {
      title: "Settings",
      description: "Open settings to switch starter templates, manage env vars, and import/export.",
    },
  },
  {
    element: '[data-tour="slides"]',
    popover: {
      title: "Slides",
      description: "Manage presentation slides to overlay on your recording.",
    },
  },
  {
    element: '[data-tour="preview"]',
    popover: {
      title: "Preview",
      description: "Toggle the live preview panel to see your project render as you type.",
    },
  },
  {
    element: '[data-tour="runner"]',
    popover: {
      title: "Runner",
      description:
        "Toggle the runner dock here to show or hide the terminal and dev-server output.",
    },
  },
];

function buildTourSteps(): DriveStep[] {
  return TOUR_STEPS.filter((step) => document.querySelector(step.element));
}

export function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, "1");
  } catch {
    // Storage unavailable (e.g. private browsing) — silently skip.
  }
}

export function startTour({ force = false }: { force?: boolean } = {}): void {
  if (!force && hasSeenTour()) {
    return;
  }

  const steps = buildTourSteps();

  if (steps.length === 0) {
    return;
  }

  const tourDriver = driver({
    showProgress: true,
    allowClose: true,
    overlayOpacity: 0.6,
    stagePadding: 6,
    stageRadius: 8,
    popoverClass: "ne-tour-popover",
    steps,
    onDestroyed: () => {
      markTourSeen();
    },
  });

  tourDriver.drive();
}
