import type { RuntimeRecordingSnapshot } from "../types/runtime";
import type { PreviewSize } from "../types/slides";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function areStringArraysEqual(left?: string[], right?: string[]): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

export function areStructuredDataEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (left == null || right == null || typeof left !== typeof right) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      return false;
    }

    if (left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => areStructuredDataEqual(value, right[index]));
  }

  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }

  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      areStructuredDataEqual(left[key], right[key]),
  );
}

export function arePreviewSizesEqual(left: PreviewSize, right: PreviewSize): boolean {
  if (left === right) {
    return true;
  }

  if (typeof left === "string" || typeof right === "string") {
    return false;
  }

  return left.width === right.width && left.height === right.height;
}

export function areRuntimeRecordingSnapshotsEqual(
  left: RuntimeRecordingSnapshot,
  right: RuntimeRecordingSnapshot,
): boolean {
  return (
    left.mode === right.mode &&
    left.status === right.status &&
    left.previewUrl === right.previewUrl &&
    left.lastOutput === right.lastOutput &&
    left.activeCommand === right.activeCommand &&
    left.errorMessage === right.errorMessage &&
    left.activeTab === right.activeTab &&
    left.isCollapsed === right.isCollapsed &&
    left.isSettingsOpen === right.isSettingsOpen &&
    areStringArraysEqual(left.consoleLines, right.consoleLines)
  );
}
