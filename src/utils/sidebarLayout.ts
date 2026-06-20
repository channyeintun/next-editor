export const DEFAULT_FILE_SIDEBAR_WIDTH = 248;
export const MIN_FILE_SIDEBAR_WIDTH = 200;
export const MAX_FILE_SIDEBAR_WIDTH = 520;
export const MIN_MAIN_EDITOR_WIDTH = 360;
export const FILE_SIDEBAR_WIDTH_STORAGE_KEY = "next-editor:file-sidebar-width";
export const FILE_SIDEBAR_COLLAPSED_STORAGE_KEY = "next-editor:file-sidebar-collapsed";
export const FILE_SIDEBAR_KEYBOARD_STEP = 16;
export const FILE_SIDEBAR_KEYBOARD_LARGE_STEP = 48;

function clampValue(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

export function getFileSidebarMaxWidth(viewportWidth?: number): number {
  if (typeof viewportWidth !== "number" || !Number.isFinite(viewportWidth)) {
    return MAX_FILE_SIDEBAR_WIDTH;
  }

  const availableWidth = viewportWidth - MIN_MAIN_EDITOR_WIDTH;
  return clampValue(availableWidth, MIN_FILE_SIDEBAR_WIDTH, MAX_FILE_SIDEBAR_WIDTH);
}

export function getClampedFileSidebarWidth(width: number, viewportWidth?: number): number {
  const nextWidth = Number.isFinite(width) ? width : DEFAULT_FILE_SIDEBAR_WIDTH;
  return clampValue(nextWidth, MIN_FILE_SIDEBAR_WIDTH, getFileSidebarMaxWidth(viewportWidth));
}

export function readStoredFileSidebarWidth(): number {
  if (typeof window === "undefined") {
    return DEFAULT_FILE_SIDEBAR_WIDTH;
  }

  let storedValue: string | null = null;

  try {
    storedValue = window.localStorage.getItem(FILE_SIDEBAR_WIDTH_STORAGE_KEY);
  } catch {
    return DEFAULT_FILE_SIDEBAR_WIDTH;
  }

  if (!storedValue) {
    return DEFAULT_FILE_SIDEBAR_WIDTH;
  }

  return getClampedFileSidebarWidth(Number(storedValue), window.innerWidth);
}

export function writeStoredFileSidebarWidth(width: number): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(FILE_SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function readStoredFileSidebarCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(FILE_SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeStoredFileSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(FILE_SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
