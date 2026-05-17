import type { RuntimeRecordingSnapshot } from "../types/runtime";
import type { PreviewSize } from "../types/slides";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function areStringArraysEqual(
  left?: string[],
  right?: string[],
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function areTerminalSessionsEqual(
  left?: RuntimeRecordingSnapshot["terminalSessions"],
  right?: RuntimeRecordingSnapshot["terminalSessions"],
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every(
    (session, index) =>
      session.id === right[index]?.id &&
      session.title === right[index]?.title &&
      session.output === right[index]?.output,
  );
}

function areTerminalEventsEqual(
  left?: RuntimeRecordingSnapshot["terminalEvents"],
  right?: RuntimeRecordingSnapshot["terminalEvents"],
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every(
    (event, index) =>
      event.id === right[index]?.id &&
      event.type === right[index]?.type &&
      event.sessionId === right[index]?.sessionId &&
      event.chunk === right[index]?.chunk &&
      event.cols === right[index]?.cols &&
      event.rows === right[index]?.rows &&
      event.title === right[index]?.title,
  );
}

export function areStructuredDataEqual(
  left: unknown,
  right: unknown,
): boolean {
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

    return left.every((value, index) =>
      areStructuredDataEqual(value, right[index]),
    );
  }

  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
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

export function arePreviewSizesEqual(
  left: PreviewSize,
  right: PreviewSize,
): boolean {
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
    left.terminalOutput === right.terminalOutput &&
    areTerminalSessionsEqual(left.terminalSessions, right.terminalSessions) &&
    areTerminalEventsEqual(left.terminalEvents, right.terminalEvents) &&
    left.terminalEventCount === right.terminalEventCount &&
    left.activeTerminalSessionId === right.activeTerminalSessionId &&
    left.activeCommand === right.activeCommand &&
    left.errorMessage === right.errorMessage &&
    left.activeTab === right.activeTab &&
    left.isCollapsed === right.isCollapsed &&
    left.isSettingsOpen === right.isSettingsOpen &&
    areStringArraysEqual(left.consoleLines, right.consoleLines)
  );
}