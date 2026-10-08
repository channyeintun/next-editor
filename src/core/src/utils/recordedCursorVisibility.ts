export const RECORDED_CURSOR_VISIBILITY_EVENT = "next-editor:recorded-cursor-visibility";

export interface RecordedCursorVisibilityDetail {
  x: number;
  y: number;
  visible: boolean;
}

export function isRecordedCursorVisibilityDetail(
  detail: unknown,
): detail is RecordedCursorVisibilityDetail {
  if (!detail || typeof detail !== "object") {
    return false;
  }

  const value = detail as Partial<RecordedCursorVisibilityDetail>;
  return (
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.visible === "boolean"
  );
}

export function dispatchRecordedCursorVisibility(detail: RecordedCursorVisibilityDetail): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(RECORDED_CURSOR_VISIBILITY_EVENT, { detail }));
}
