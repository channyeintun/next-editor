import { driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";

const TOUR_SEEN_KEY = "next-editor.tour.v1.seen";

type ProductTourStep = DriveStep & {
  element: string;
  mountsAfter?: string;
};

const TOUR_STEPS: ProductTourStep[] = [
  {
    element: '[data-tour="record"]',
    popover: {
      title: "Record",
      description: "Click here to start (or stop) recording your coding session.",
    },
  },
  {
    element: '[data-tour="mic"]',
    popover: {
      title: "Microphone",
      description: "Record audio from your microphone while coding.",
    },
  },
  {
    element: '[data-tour="audio-file"]',
    popover: {
      title: "Audio File",
      description: "Use a pre-recorded audio file instead of the microphone.",
    },
  },
  {
    element: '[data-tour="camera"]',
    popover: {
      title: "Camera",
      description: "Toggle camera recording to overlay your webcam on the session.",
    },
  },
  {
    element: '[data-tour="screen"]',
    popover: {
      title: "Screen",
      description:
        "Toggle screen recording to capture your lesson. This is only required if you want to upload your lesson to YouTube or other platforms.",
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
    element: '[data-tour="whiteboard"]',
    popover: {
      title: "Whiteboard",
      description: "Open the whiteboard to sketch and annotate alongside your code.",
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
  {
    element: '[data-tour="agent"]',
    popover: {
      title: "Agent",
      description: "Open the Agent tab to ask for changes, fixes, or help with this workspace.",
      onNextClick: (element, _step, { driver: tourDriver }) => {
        // The settings button is mounted inside the Agent panel. Open the tab and,
        // when necessary, expand the dock before advancing to that target.
        if (element instanceof HTMLElement) {
          element.click();
        }

        const dockToggle = document.querySelector<HTMLElement>('[data-tour="runner"]');
        if (dockToggle?.getAttribute("aria-label") === "Expand runtime dock") {
          dockToggle.click();
        }

        requestAnimationFrame(() => tourDriver.moveNext());
      },
    },
  },
  {
    element: '[data-tour="agent-settings"]',
    // This control is mounted only after the preceding Agent step opens the panel.
    mountsAfter: '[data-tour="agent"]',
    popover: {
      title: "Agent settings",
      description: "Choose a model, add your OpenRouter API key, and control where it is stored.",
    },
  },
];

function buildTourSteps(): DriveStep[] {
  return TOUR_STEPS.filter(
    (step) =>
      document.querySelector(step.element) ||
      (step.mountsAfter && document.querySelector(step.mountsAfter)),
  ).map(({ mountsAfter: _mountsAfter, ...step }) => step);
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
