import type {
  CanvasBreakpoint,
  CanvasRect,
  ResponsiveCanvasRects,
} from "./types.ts";

export interface CanvasRectChanges {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface AxisDistance {
  gap: number;
  overlap: number;
}

export interface RectDistance {
  x: AxisDistance;
  y: AxisDistance;
}

export function isValidCanvasRect(value: CanvasRect): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width > 0 &&
    value.height > 0
  );
}

export function isValidSpacingPx(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function updateResponsiveCanvasRect(
  placement: ResponsiveCanvasRects,
  breakpoint: CanvasBreakpoint,
  rect: CanvasRect,
): ResponsiveCanvasRects {
  if (!isValidCanvasRect(rect)) {
    throw new RangeError("Canvas rectangle values are invalid.");
  }
  return {
    ...placement,
    [breakpoint]: { ...rect },
  };
}

export function updateCanvasRect(
  rect: CanvasRect,
  changes: CanvasRectChanges,
): CanvasRect {
  const updated = { ...rect, ...changes };
  if (!isValidCanvasRect(updated)) {
    throw new RangeError("Canvas rectangle values are invalid.");
  }
  return updated;
}

function axisDistance(
  firstStart: number,
  firstSize: number,
  secondStart: number,
  secondSize: number,
): AxisDistance {
  const firstEnd = firstStart + firstSize;
  const secondEnd = secondStart + secondSize;
  const overlap = Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart);
  if (overlap > 0) {
    return { gap: -overlap, overlap };
  }
  return {
    gap:
      firstEnd <= secondStart
        ? secondStart - firstEnd
        : firstStart - secondEnd,
    overlap: 0,
  };
}

export function measureCanvasRectDistance(
  first: CanvasRect,
  second: CanvasRect,
): RectDistance {
  return {
    x: axisDistance(first.x, first.width, second.x, second.width),
    y: axisDistance(first.y, first.height, second.y, second.height),
  };
}
