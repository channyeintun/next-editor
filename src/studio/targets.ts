import type { StudioPlaygroundRuntimeKind, StudioTargetRef } from "./plan";

/**
 * Durable UI target resolution for the studio pointer's clicks. Product
 * components opt surfaces in with `data-studio-target`; the driver resolves
 * refs to live elements at act time. A missing target is a render failure —
 * never a coordinate fallback (docs/agent-lesson-production.md §7).
 */

export const STUDIO_TARGET_ATTRIBUTE = "data-studio-target";

/**
 * Marks the part of a target a hand actually aims at, when that is not the
 * whole element: a file row is a full-width button whose middle is empty space
 * to the right of a short name, so the row's name carries this and the pointer
 * lands on the name.
 */
export const STUDIO_TARGET_AIM_ATTRIBUTE = "data-studio-aim";

export function studioTargetIdForFile(path: string): string {
  return `file:${path}`;
}

export const STUDIO_RUN_BUTTON_TARGET_ID = "runtime-run";

/** The runner dock's collapse/expand chevron — the control to click while the dock is shut. */
export const STUDIO_DOCK_TOGGLE_TARGET_ID = "runtime-dock-toggle";

/** The runtime preview iframe a `preview` target's element lives inside. */
const PREVIEW_FRAME_SELECTOR = '[data-cursor-replay-target="preview-frame"]';

/**
 * Runner dock containers, one per playground kind. The pointer clicks the Run
 * button or the dock's chevron rather than the dock itself (the middle of a
 * dock is empty console), but the runner panels still mark their docks.
 */
export const STUDIO_GO_DOCK_TARGET_ID = "go-runner-dock";
export const STUDIO_KOTLIN_DOCK_TARGET_ID = "kotlin-runner-dock";
export const STUDIO_RUST_DOCK_TARGET_ID = "rust-runner-dock";
export const STUDIO_ZIG_DOCK_TARGET_ID = "zig-runner-dock";
export const STUDIO_HASKELL_DOCK_TARGET_ID = "haskell-runner-dock";
export const STUDIO_KITE_DOCK_TARGET_ID = "kite-runner-dock";
export const STUDIO_ASM_DOCK_TARGET_ID = "asm-runner-dock";

/** The runner dock container for a playground kind. */
export function dockTargetIdForRuntime(kind: StudioPlaygroundRuntimeKind): string {
  switch (kind) {
    case "go-playground":
      return STUDIO_GO_DOCK_TARGET_ID;
    case "kotlin-playground":
      return STUDIO_KOTLIN_DOCK_TARGET_ID;
    case "rust-playground":
      return STUDIO_RUST_DOCK_TARGET_ID;
    case "zig-playground":
      return STUDIO_ZIG_DOCK_TARGET_ID;
    case "haskell-playground":
      return STUDIO_HASKELL_DOCK_TARGET_ID;
    case "kite-playground":
      return STUDIO_KITE_DOCK_TARGET_ID;
    case "asm-playground":
      return STUDIO_ASM_DOCK_TARGET_ID;
  }
}

function findByStudioTargetId(id: string): Element | null {
  // The id is interpolated into a *quoted* attribute selector, so it needs CSS
  // string escaping — the closing quote and backslashes — not `CSS.escape`, which
  // escapes identifiers. `CSS.escape` happened to work for every id in use, since
  // its output survives the string tokenizer intact, but it is the wrong escape
  // for this position and only accidentally correct.
  const escaped = id.replace(/["\\]/g, "\\$&");
  return document.querySelector(`[${STUDIO_TARGET_ATTRIBUTE}="${escaped}"]`);
}

export function describeStudioTarget(ref: StudioTargetRef): string {
  switch (ref.kind) {
    case "file":
      return `file row "${ref.path}"`;
    case "editor":
      return "code editor surface";
    case "run-button":
      return "runtime Run button";
    case "target-id":
      return `studio target "${ref.id}"`;
    case "preview":
      return `preview element "${ref.testId}"`;
  }
}

export function resolveStudioTarget(ref: StudioTargetRef): Element | null {
  switch (ref.kind) {
    case "file":
      return findByStudioTargetId(studioTargetIdForFile(ref.path));
    case "editor":
      return document.querySelector('[data-cursor-replay-target="code-editor"]');
    case "run-button":
      return findByStudioTargetId(STUDIO_RUN_BUTTON_TARGET_ID);
    case "target-id":
      return findByStudioTargetId(ref.id);
    case "preview":
      // The element itself is inside a cross-origin frame; the host can only
      // resolve the frame and asks the preview bridge where the element is.
      return document.querySelector(PREVIEW_FRAME_SELECTOR);
  }
}

/**
 * The point a hand aims at on a resolved target: the centre of its marked aim
 * part when it has one, else the centre of the element.
 */
export function studioTargetAimPoint(element: Element): { x: number; y: number } {
  const aim = element.querySelector(`[${STUDIO_TARGET_AIM_ATTRIBUTE}]`) ?? element;
  const rect = aim.getBoundingClientRect();
  const box = rect.width > 0 || rect.height > 0 ? rect : element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}
