import {
  collectAxisGuides,
  getAlignmentTargets,
} from "./alignment.ts";
import type {
  AlignmentGuide,
  AlignmentTarget,
} from "./alignment.ts";
import type { CanvasBounds, CanvasRect } from "./types.ts";

export function findAlignmentGuides(
  rect: CanvasRect,
  targets: readonly AlignmentTarget[],
  tolerance: number,
  canvas?: CanvasBounds,
): AlignmentGuide[] {
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError("Alignment tolerance must be a non-negative number.");
  }
  const allTargets = getAlignmentTargets(targets, canvas);
  return [
    ...collectAxisGuides(rect, allTargets, "x", tolerance),
    ...collectAxisGuides(rect, allTargets, "y", tolerance),
  ];
}
