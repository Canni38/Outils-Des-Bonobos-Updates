import { updateCanvasRect } from "./geometry.ts";
import type { CanvasRect } from "./types.ts";

export function translateCanvasRect(
  rect: CanvasRect,
  deltaX: number,
  deltaY: number,
): CanvasRect {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    throw new RangeError("Canvas translation values must be finite.");
  }
  return updateCanvasRect(rect, {
    x: rect.x + deltaX,
    y: rect.y + deltaY,
  });
}
