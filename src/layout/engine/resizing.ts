import { updateCanvasRect } from "./geometry.ts";
import type { CanvasRect } from "./types.ts";

export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

export function resizeCanvasRect(
  rect: CanvasRect,
  edges: ResizeEdges,
  deltaX: number,
  deltaY: number,
): CanvasRect {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    throw new RangeError("Canvas resize values must be finite.");
  }

  const next = { ...rect };
  if (edges.left) {
    next.x += deltaX;
    next.width -= deltaX;
  } else if (edges.right) {
    next.width += deltaX;
  }
  if (edges.top) {
    next.y += deltaY;
    next.height -= deltaY;
  } else if (edges.bottom) {
    next.height += deltaY;
  }
  return updateCanvasRect(rect, next);
}
