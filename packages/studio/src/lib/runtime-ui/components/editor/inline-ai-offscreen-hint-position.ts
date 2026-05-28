type HintSurfaceRect = Pick<DOMRect, "left" | "width"> | undefined;

export function getPickerOffscreenHintLeft(
  surfaceRect: HintSurfaceRect,
  viewportWidth: number,
): number {
  return surfaceRect
    ? surfaceRect.left + surfaceRect.width / 2
    : viewportWidth / 2;
}
