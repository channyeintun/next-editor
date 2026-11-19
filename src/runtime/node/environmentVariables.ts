// The environment variables every runtime process is spawned with, and the
// workspace they belong to.
import type { EnvironmentVariables } from "./types";
import { areWorkspaceBoundariesEqual, type WorkspaceBoundary } from "../../stores/workspaceStore";

// Where builds before the workspace binding kept the variables, read back into
// every project the browser opened afterwards.
const LEGACY_RUNTIME_ENVIRONMENT_STORAGE_KEY = "next-editor-runtime-environment";

/** No variables, as one object, so a check by identity sees two empty sets as equal. */
export const NO_ENVIRONMENT_VARIABLES: EnvironmentVariables = Object.freeze({});

/**
 * The workspace a process would run for: the store's boundary, and whether a live
 * room owns the workspace (a room projects its creator's project over it, under
 * any id and without a load).
 */
export interface RuntimeWorkspaceScope extends WorkspaceBoundary {
  liveRoom: boolean;
}

/**
 * The variables the runtime spawns with, and the workspace they were saved in.
 *
 * Variables the user saves belong to the workspace on screen at the time. A lesson,
 * recording or room project loaded after that is another author's code, whose
 * install and dev scripts run with these variables, so they stop applying there.
 * For the same reason they are kept only in memory: stored in the browser, every
 * later project would read them back. `scope` null marks variables a caller set as
 * the runtime's contract (the studio's configureRuntime), which apply to the
 * project it loads next.
 */
export interface RuntimeEnvironment {
  variables: EnvironmentVariables;
  scope: RuntimeWorkspaceScope | null;
}

export const EMPTY_RUNTIME_ENVIRONMENT: RuntimeEnvironment = {
  variables: NO_ENVIRONMENT_VARIABLES,
  scope: null,
};

export function normalizeEnvironmentVariables(
  variables: EnvironmentVariables,
): EnvironmentVariables {
  const entries = Object.entries(variables)
    .map(([key, value]) => [key.trim(), String(value)] as const)
    .filter(([key]) => key.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  return entries.length > 0 ? Object.fromEntries(entries) : NO_ENVIRONMENT_VARIABLES;
}

function areRuntimeWorkspaceScopesEqual(
  left: RuntimeWorkspaceScope,
  right: RuntimeWorkspaceScope,
): boolean {
  return left.liveRoom === right.liveRoom && areWorkspaceBoundariesEqual(left, right);
}

/** Whether `environment` belongs to a workspace other than `current`. */
export function isEnvironmentForAnotherWorkspace(
  environment: RuntimeEnvironment,
  current: RuntimeWorkspaceScope | null,
): boolean {
  return (
    environment.scope !== null &&
    (current === null || !areRuntimeWorkspaceScopesEqual(environment.scope, current))
  );
}

/** The variables a process started for `current` gets: none saved in another workspace. */
export function resolveEnvironmentVariables(
  environment: RuntimeEnvironment,
  current: RuntimeWorkspaceScope | null,
): EnvironmentVariables {
  return isEnvironmentForAnotherWorkspace(environment, current)
    ? NO_ENVIRONMENT_VARIABLES
    : environment.variables;
}

/** Deletes the variables an older build kept in the browser for every project. */
export function discardLegacyStoredEnvironmentVariables(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(LEGACY_RUNTIME_ENVIRONMENT_STORAGE_KEY);
  } catch (error) {
    console.warn("Failed to remove stored runtime environment variables:", error);
  }
}
