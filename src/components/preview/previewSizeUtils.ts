import type { PreviewSize } from "../../types/slides";

export type CustomPreviewSize = Extract<PreviewSize, { width: number; height: number }>;

export const MIN_CUSTOM_PREVIEW_WIDTH = 160;
export const MIN_CUSTOM_PREVIEW_HEIGHT = 120;
export const PREVIEW_VIEWPORT_HORIZONTAL_GUTTER = 16;
export const PREVIEW_VIEWPORT_VERTICAL_RESERVED = 96;

export function isCustomPreviewSize(size: PreviewSize): size is CustomPreviewSize {
  return typeof size === "object";
}

export function clampCustomPreviewSize(
  size: CustomPreviewSize,
  viewport: { width: number; height: number },
): CustomPreviewSize {
  const maxWidth = Math.max(1, viewport.width - PREVIEW_VIEWPORT_HORIZONTAL_GUTTER * 2);
  const maxHeight = Math.max(1, viewport.height - PREVIEW_VIEWPORT_VERTICAL_RESERVED);

  return {
    width: Math.min(maxWidth, Math.max(MIN_CUSTOM_PREVIEW_WIDTH, size.width)),
    height: Math.min(maxHeight, Math.max(MIN_CUSTOM_PREVIEW_HEIGHT, size.height)),
  };
}

export function getCustomPreviewSizeFromResize({
  startSize,
  startPointer,
  currentPointer,
  viewport,
}: {
  startSize: CustomPreviewSize;
  startPointer: { x: number; y: number };
  currentPointer: { x: number; y: number };
  viewport: { width: number; height: number };
}): CustomPreviewSize {
  return clampCustomPreviewSize(
    {
      width: startSize.width + startPointer.x - currentPointer.x,
      height: startSize.height + currentPointer.y - startPointer.y,
    },
    viewport,
  );
}
