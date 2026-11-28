import {
  collectAxisGuides,
  findClosestSnapDelta,
  getAlignmentTargets,
} from "./alignment.ts";
import type {
  AlignmentGuide,
  AlignmentOptions,
  AlignmentTarget,
} from "./alignment.ts";
import type { CanvasRect } from "./types.ts";
import { updateCanvasRect } from "./geometry.ts";
import type { ResizeEdges } from "./resizing.ts";

export interface MagnetismResult {
  rect: CanvasRect;
  guides: AlignmentGuide[];
}

export function alignCanvasRect(
  rect: CanvasRect,
  targets: readonly AlignmentTarget[],
  options: AlignmentOptions,
): MagnetismResult {
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0) {
    throw new RangeError("Alignment tolerance must be a non-negative number.");
  }

  const allTargets = getAlignmentTargets(targets, options.canvas);
  if (!options.enabled) {
    return {
      rect,
      guides: [
        ...collectAxisGuides(rect, allTargets, "x", options.tolerance),
        ...collectAxisGuides(rect, allTargets, "y", options.tolerance),
      ],
    };
  }

  const snapped = {
    ...rect,
    x: rect.x + findClosestSnapDelta(rect, allTargets, "x", options.tolerance),
    y: rect.y + findClosestSnapDelta(rect, allTargets, "y", options.tolerance),
  };
  return {
    rect: snapped,
    guides: [
      ...collectAxisGuides(snapped, allTargets, "x", 0),
      ...collectAxisGuides(snapped, allTargets, "y", 0),
    ],
  };
}

export function alignResizedCanvasRect(
  rect: CanvasRect,
  targets: readonly AlignmentTarget[],
  options: AlignmentOptions,
  edges: ResizeEdges,
): MagnetismResult {
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0) {
    throw new RangeError("Alignment tolerance must be a non-negative number.");
  }

  const allTargets = getAlignmentTargets(targets, options.canvas);
  if (!options.enabled) {
    return {
      rect,
      guides: [
        ...collectAxisGuides(rect, allTargets, "x", options.tolerance),
        ...collectAxisGuides(rect, allTargets, "y", options.tolerance),
      ],
    };
  }

  let next = rect;
  if (edges.left || edges.right) {
    const edge = edges.left ? "start" : "end";
    const delta = findClosestSnapDelta(
      next,
      allTargets,
      "x",
      options.tolerance,
      edge,
    );
    if (edges.left && next.width - delta > 0) {
      next = updateCanvasRect(next, {
        x: next.x + delta,
        width: next.width - delta,
      });
    } else if (edges.right && next.width + delta > 0) {
      next = updateCanvasRect(next, { width: next.width + delta });
    }
  }
  if (edges.top || edges.bottom) {
    const edge = edges.top ? "start" : "end";
    const delta = findClosestSnapDelta(
      next,
      allTargets,
      "y",
      options.tolerance,
      edge,
    );
    if (edges.top && next.height - delta > 0) {
      next = updateCanvasRect(next, {
        y: next.y + delta,
        height: next.height - delta,
      });
    } else if (edges.bottom && next.height + delta > 0) {
      next = updateCanvasRect(next, { height: next.height + delta });
    }
  }

  return {
    rect: next,
    guides: [
      ...collectAxisGuides(next, allTargets, "x", 0),
      ...collectAxisGuides(next, allTargets, "y", 0),
    ],
  };
}
