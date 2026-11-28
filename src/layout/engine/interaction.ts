import { findAlignmentGuides } from "./guides.ts";
import {
  alignCanvasRect,
  alignResizedCanvasRect,
} from "./magnetism.ts";
import type {
  AlignmentOptions,
  AlignmentTarget,
} from "./alignment.ts";
import { resizeCanvasRect } from "./resizing.ts";
import { translateCanvasRect } from "./positioning.ts";
import type { CanvasRect } from "./types.ts";
import type { ResizeEdges } from "./resizing.ts";

export type CanvasGestureMode = "move" | "resize";

export interface CanvasGesture<TPayload> {
  itemId: string;
  payload: TPayload;
  mode: CanvasGestureMode;
  startPoint: { x: number; y: number };
  startRect: CanvasRect;
  edges: ResizeEdges;
  targets: readonly AlignmentTarget[];
}

export interface CanvasGestureUpdateOptions extends AlignmentOptions {
  preserveAspectRatio: boolean;
}

function clampResizeDelta(
  rect: CanvasRect,
  edges: ResizeEdges,
  deltaX: number,
  deltaY: number,
): { deltaX: number; deltaY: number } {
  let nextX = deltaX;
  let nextY = deltaY;
  if (edges.left) {
    nextX = Math.min(nextX, rect.width - 1);
  } else if (edges.right) {
    nextX = Math.max(nextX, 1 - rect.width);
  }
  if (edges.top) {
    nextY = Math.min(nextY, rect.height - 1);
  } else if (edges.bottom) {
    nextY = Math.max(nextY, 1 - rect.height);
  }
  return { deltaX: nextX, deltaY: nextY };
}

function preserveAspectRatio(
  rect: CanvasRect,
  original: CanvasRect,
  edges: ResizeEdges,
): CanvasRect {
  const aspectRatio = original.width / original.height;
  const widthChange = Math.abs(rect.width - original.width) / original.width;
  const heightChange = Math.abs(rect.height - original.height) / original.height;
  let width = rect.width;
  let height = rect.height;

  if (widthChange >= heightChange) {
    height = width / aspectRatio;
  } else {
    width = height * aspectRatio;
  }

  let x = rect.x;
  let y = rect.y;
  if (edges.left) {
    x = original.x + original.width - width;
  } else if (!edges.right) {
    x = original.x + (original.width - width) / 2;
  }
  if (edges.top) {
    y = original.y + original.height - height;
  } else if (!edges.bottom) {
    y = original.y + (original.height - height) / 2;
  }
  return { x, y, width, height };
}

export function updateCanvasGesture<TPayload>(
  gesture: CanvasGesture<TPayload>,
  pointer: { x: number; y: number },
  options: CanvasGestureUpdateOptions,
): { rect: CanvasRect; guides: ReturnType<typeof findAlignmentGuides> } {
  const deltaX = pointer.x - gesture.startPoint.x;
  const deltaY = pointer.y - gesture.startPoint.y;
  let rect =
    gesture.mode === "move"
      ? translateCanvasRect(gesture.startRect, deltaX, deltaY)
      : (() => {
          const clamped = clampResizeDelta(
            gesture.startRect,
            gesture.edges,
            deltaX,
            deltaY,
          );
          return resizeCanvasRect(
            gesture.startRect,
            gesture.edges,
            clamped.deltaX,
            clamped.deltaY,
          );
        })();

  if (gesture.mode === "resize" && options.preserveAspectRatio) {
    rect = preserveAspectRatio(rect, gesture.startRect, gesture.edges);
  }

  const alignmentOptions: AlignmentOptions = {
    enabled: options.enabled,
    tolerance: options.tolerance,
    canvas: options.canvas,
  };
  const aligned =
    gesture.mode === "resize"
      ? alignResizedCanvasRect(
          rect,
          gesture.targets,
          alignmentOptions,
          gesture.edges,
        )
      : alignCanvasRect(rect, gesture.targets, alignmentOptions);

  rect =
    gesture.mode === "resize" && options.preserveAspectRatio
      ? preserveAspectRatio(aligned.rect, gesture.startRect, gesture.edges)
      : aligned.rect;
  const guides =
    gesture.mode === "resize" && options.preserveAspectRatio
      ? findAlignmentGuides(
          rect,
          gesture.targets,
          options.tolerance,
          options.canvas,
        )
      : aligned.guides;
  return { rect, guides };
}
