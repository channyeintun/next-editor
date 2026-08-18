import type { StudioTargetRef } from "./plan";

/**
 * Durable UI target resolution for the Performer's attention cursor. Product
 * components opt surfaces in with `data-studio-target`; the driver resolves
 * refs to live elements at act time. A missing target is a render failure —
 * never a coordinate fallback (docs/agent-lesson-production.md §7).
 */

export const STUDIO_TARGET_ATTRIBUTE = "data-studio-target";

export function studioTargetIdForFile(path: string): string {
  return `file:${path}`;
}

export const STUDIO_RUN_BUTTON_TARGET_ID = "runtime-run";

/**
 * Runner dock containers, one per playground kind. Unattended fixture renders
 * point the attention cursor here instead of the Run button, which is replaced
 * by a sign-in button for signed-out sessions and would otherwise be a
 * missing-target failure.
 */
export const STUDIO_GO_DOCK_TARGET_ID = "go-runner-dock";
export const STUDIO_KOTLIN_DOCK_TARGET_ID = "kotlin-runner-dock";
export const STUDIO_RUST_DOCK_TARGET_ID = "rust-runner-dock";
export const STUDIO_ZIG_DOCK_TARGET_ID = "zig-runner-dock";
export const STUDIO_KITE_DOCK_TARGET_ID = "kite-runner-dock";
export const STUDIO_ASM_DOCK_TARGET_ID = "asm-runner-dock";

/** The dock the attention cursor moves toward before `runtime.run`. */
export function dockTargetIdForRuntime(
  kind:
    | "go-playground"
    | "kotlin-playground"
    | "rust-playground"
    | "zig-playground"
    | "kite-playground"
    | "asm-playground",
): string {
  switch (kind) {
    case "go-playground":
      return STUDIO_GO_DOCK_TARGET_ID;
    case "kotlin-playground":
      return STUDIO_KOTLIN_DOCK_TARGET_ID;
    case "rust-playground":
      return STUDIO_RUST_DOCK_TARGET_ID;
    case "zig-playground":
      return STUDIO_ZIG_DOCK_TARGET_ID;
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
  }
}
