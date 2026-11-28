import type {
  CanvasBreakpoint,
  CanvasRect,
  ResponsiveCanvasRects,
} from "../engine/types.ts";

export const LAYOUT_SCHEMA_VERSION = 3 as const;

export type LayoutAlignment = "left" | "center" | "right";
export type LayoutSpacing = "none" | "small" | "medium" | "large";
export type LayoutIconId = "info" | "check" | "arrow-right";
export type LayoutMode = "flow" | "free";
export type LayoutBreakpoint = CanvasBreakpoint;

export type LayoutRect = CanvasRect;
export type ResponsiveLayoutPlacement = ResponsiveCanvasRects;

export interface LayoutNodeProperties {
  name?: string;
  alignment?: LayoutAlignment;
  spacing?: LayoutSpacing;
  spacingPx?: number;
  placement?: ResponsiveLayoutPlacement;
  zIndex?: number;
}

export interface ResponsiveSpan {
  mobile: number;
  tablet: number;
  desktop: number;
}

export interface HeadingBlock extends LayoutNodeProperties {
  type: "heading";
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

export interface TextBlock extends LayoutNodeProperties {
  type: "text";
  id: string;
  text: string;
  tone: "default" | "muted" | "accent";
}

export interface ButtonBlock extends LayoutNodeProperties {
  type: "button";
  id: string;
  label: string;
  actionId: string;
  variant: "primary" | "secondary";
  iconId?: LayoutIconId;
  detachedIcon?: LayoutIconObject;
}

export interface LayoutIconObject {
  type: "icon";
  id: string;
  iconId: LayoutIconId;
  name?: string;
  spacingPx?: number;
  placement: ResponsiveLayoutPlacement;
  zIndex: number;
}

export interface CardBlock extends LayoutNodeProperties {
  type: "card";
  id: string;
  title: string;
  content: string;
}

export interface SeparatorBlock extends LayoutNodeProperties {
  type: "separator";
  id: string;
}

export type LayoutBlock =
  | HeadingBlock
  | TextBlock
  | ButtonBlock
  | CardBlock
  | SeparatorBlock;

export interface LayoutColumn extends LayoutNodeProperties {
  type: "column";
  id: string;
  span?: ResponsiveSpan;
  blocks: LayoutBlock[];
}

export interface LayoutRow extends LayoutNodeProperties {
  type: "row";
  id: string;
  columns: LayoutColumn[];
}

export interface LayoutPage {
  id: string;
  title: string;
  order: number;
  layoutMode: LayoutMode;
  rows: LayoutRow[];
}

export interface LayoutConfig {
  schemaVersion: typeof LAYOUT_SCHEMA_VERSION;
  layoutId: string;
  pages: LayoutPage[];
}

export interface LayoutConfigV2 {
  schemaVersion: 2;
  layoutId: string;
  pages: LayoutPageV2[];
}

export type LayoutPageV2 = Omit<LayoutPage, "layoutMode">;

export interface LayoutConfigV1 {
  schemaVersion: 1;
  layoutId: string;
  pages: LayoutPageV1[];
}

export interface LayoutPageV1 {
  id: string;
  title: string;
  order: number;
  rows: LayoutRowV1[];
}

export interface LayoutRowV1 {
  type: "row";
  id: string;
  columns: LayoutColumnV1[];
}

export interface LayoutColumnV1 {
  type: "column";
  id: string;
  span: ResponsiveSpan;
  blocks: LayoutBlockV1[];
}

export type LayoutBlockV1 =
  | {
      type: "heading";
      id: string;
      text: string;
      level: 1 | 2 | 3;
    }
  | {
      type: "text";
      id: string;
      text: string;
      tone: "default" | "muted" | "accent";
    }
  | {
      type: "button";
      id: string;
      label: string;
      actionId: string;
      variant: "primary" | "secondary";
    };
