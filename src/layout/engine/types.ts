export const CANVAS_ENGINE_VERSION = 1 as const;

export const canvasBreakpoints = ["desktop", "tablet", "mobile"] as const;

export type CanvasBreakpoint = (typeof canvasBreakpoints)[number];

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResponsiveCanvasRects = Record<CanvasBreakpoint, CanvasRect>;

export interface CanvasItem<TPayload> {
  id: string;
  payload: TPayload;
  placement: ResponsiveCanvasRects;
  zIndex: number;
  spacingPx?: number;
}

export interface CanvasDocument<TPayload> {
  engineVersion: typeof CANVAS_ENGINE_VERSION;
  items: CanvasItem<TPayload>[];
}

export interface CanvasInteractionPreferences {
  snapEnabled: boolean;
  snapTolerance: number;
}

export const defaultCanvasInteractionPreferences: CanvasInteractionPreferences =
  {
    snapEnabled: false,
    snapTolerance: 8,
  };

export interface CanvasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
