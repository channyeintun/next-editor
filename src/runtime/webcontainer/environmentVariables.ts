// The environment variables every runtime process is spawned with, and where
// they persist between visits.
import type { EnvironmentVariables } from "./types";

const RUNTIME_ENVIRONMENT_STORAGE_KEY = "next-editor-runtime-environment";

export function normalizeEnvironmentVariables(
  variables: EnvironmentVariables,
): EnvironmentVariables {
  const entries = Object.entries(variables)
    .map(([key, value]) => [key.trim(), String(value)] as const)
    .filter(([key]) => key.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(entries);
}

export function loadStoredEnvironmentVariables(): EnvironmentVariables {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const stored = window.localStorage.getItem(RUNTIME_ENVIRONMENT_STORAGE_KEY);

    if (!stored) {
      return {};
    }

    const parsed = JSON.parse(stored) as EnvironmentVariables;
    return normalizeEnvironmentVariables(parsed);
  } catch (error) {
    console.warn("Failed to load runtime environment variables:", error);
    return {};
  }
}

export function persistEnvironmentVariables(variables: EnvironmentVariables): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (Object.keys(variables).length === 0) {
      window.localStorage.removeItem(RUNTIME_ENVIRONMENT_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(RUNTIME_ENVIRONMENT_STORAGE_KEY, JSON.stringify(variables));
  } catch (error) {
    console.warn("Failed to persist runtime environment variables:", error);
  }
}
