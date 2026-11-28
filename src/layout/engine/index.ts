export { findAlignmentGuides } from "./guides.ts";
export type {
  AlignmentAxis,
  AlignmentEdge,
  AlignmentGuide,
  AlignmentOptions,
  AlignmentTarget,
} from "./alignment.ts";
export { alignCanvasRect, alignResizedCanvasRect } from "./magnetism.ts";
export type { MagnetismResult } from "./magnetism.ts";
export {
  isValidCanvasRect,
  isValidSpacingPx,
  measureCanvasRectDistance,
  updateCanvasRect,
  updateResponsiveCanvasRect,
} from "./geometry.ts";
export type {
  AxisDistance,
  CanvasRectChanges,
  RectDistance,
} from "./geometry.ts";
export { translateCanvasRect } from "./positioning.ts";
export { resizeCanvasRect } from "./resizing.ts";
export type { ResizeEdges } from "./resizing.ts";
export { updateCanvasGesture } from "./interaction.ts";
export type {
  CanvasGesture,
  CanvasGestureMode,
  CanvasGestureUpdateOptions,
} from "./interaction.ts";
export {
  moveCanvasItemLayer,
  sortCanvasItemsByLayer,
} from "./layers.ts";
export type { LayerDirection } from "./layers.ts";
export {
  CANVAS_ENGINE_VERSION,
  canvasBreakpoints,
  defaultCanvasInteractionPreferences,
} from "./types.ts";
export type {
  CanvasBounds,
  CanvasBreakpoint,
  CanvasDocument,
  CanvasInteractionPreferences,
  CanvasItem,
  CanvasRect,
  ResponsiveCanvasRects,
} from "./types.ts";
