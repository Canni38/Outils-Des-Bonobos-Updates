import type { CanvasBounds, CanvasRect } from "./types.ts";

export type AlignmentAxis = "x" | "y";
export type AlignmentEdge = "start" | "center" | "end";

export interface AlignmentTarget {
  id: string;
  rect: CanvasRect;
}

export interface AlignmentGuide {
  axis: AlignmentAxis;
  position: number;
  sourceEdge: AlignmentEdge;
  targetEdge: AlignmentEdge;
  targetId: string;
}

export interface AlignmentOptions {
  enabled: boolean;
  tolerance: number;
  canvas?: CanvasBounds;
}

interface Feature {
  edge: AlignmentEdge;
  position: number;
}

function getFeatures(
  rect: Pick<CanvasRect, "x" | "y" | "width" | "height">,
  axis: AlignmentAxis,
): Feature[] {
  const start = axis === "x" ? rect.x : rect.y;
  const size = axis === "x" ? rect.width : rect.height;
  return [
    { edge: "start", position: start },
    { edge: "center", position: start + size / 2 },
    { edge: "end", position: start + size },
  ];
}

function toRect(target: AlignmentTarget | CanvasBounds): CanvasRect {
  return "rect" in target ? target.rect : target;
}

export function getAlignmentTargets(
  targets: readonly AlignmentTarget[],
  canvas?: CanvasBounds,
): AlignmentTarget[] {
  return [
    ...targets,
    ...(canvas === undefined ? [] : [{ id: "canvas", rect: toRect(canvas) }]),
  ];
}

export function collectAxisGuides(
  rect: CanvasRect,
  targets: readonly AlignmentTarget[],
  axis: AlignmentAxis,
  tolerance: number,
): AlignmentGuide[] {
  const activeFeatures = getFeatures(rect, axis);
  const guides: AlignmentGuide[] = [];

  for (const target of targets) {
    for (const source of activeFeatures) {
      for (const candidate of getFeatures(target.rect, axis)) {
        if (Math.abs(source.position - candidate.position) <= tolerance) {
          guides.push({
            axis,
            position: candidate.position,
            sourceEdge: source.edge,
            targetEdge: candidate.edge,
            targetId: target.id,
          });
        }
      }
    }
  }
  return guides;
}

export function findClosestSnapDelta(
  rect: CanvasRect,
  targets: readonly AlignmentTarget[],
  axis: AlignmentAxis,
  tolerance: number,
  sourceEdge?: AlignmentEdge,
): number {
  let closestDelta: number | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  const activeFeatures = getFeatures(rect, axis).filter(
    (feature) => sourceEdge === undefined || feature.edge === sourceEdge,
  );

  for (const target of targets) {
    for (const source of activeFeatures) {
      for (const candidate of getFeatures(target.rect, axis)) {
        const delta = candidate.position - source.position;
        const distance = Math.abs(delta);
        if (distance <= tolerance && distance < closestDistance) {
          closestDelta = delta;
          closestDistance = distance;
        }
      }
    }
  }
  return closestDelta ?? 0;
}
