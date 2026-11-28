import {
  canvasBreakpoints,
  measureCanvasRectDistance,
  moveCanvasItemLayer,
  updateResponsiveCanvasRect,
  type CanvasBreakpoint,
  type CanvasItem,
  type CanvasRect,
  type LayerDirection,
} from "../engine/index.ts";
import type {
  LayoutBlock,
  LayoutColumn,
  LayoutConfig,
  LayoutIconId,
  LayoutIconObject,
  LayoutPage,
  LayoutRect,
  ResponsiveLayoutPlacement,
  LayoutRow,
} from "../schema/types.ts";
import {
  updateBlock,
  updateColumn,
  updateRow,
  type LayoutSelection,
} from "./layoutOperations.ts";

const profileWidths: Record<CanvasBreakpoint, number> = {
  mobile: 375,
  tablet: 768,
  desktop: 1024,
};
const gridGap = 16;
const rowGap = 20;

export interface FreeLayoutItem {
  id: string;
  label: string;
  kind: "row" | "column" | "block" | "icon";
  selection: LayoutSelection;
  rect: LayoutRect;
  zIndex: number;
}

function getSpacingValue(spacing: LayoutBlock["spacing"]): number {
  switch (spacing) {
    case "none":
      return 0;
    case "small":
      return 8;
    case "large":
      return 24;
    default:
      return 12;
  }
}

function getColumnPadding(spacing: LayoutColumn["spacing"]): number {
  switch (spacing) {
    case "small":
      return 8;
    case "medium":
      return 16;
    case "large":
      return 24;
    default:
      return 0;
  }
}

function getRowGap(spacing: LayoutRow["spacing"]): number {
  switch (spacing) {
    case "none":
      return 0;
    case "small":
      return 10;
    case "large":
      return 32;
    default:
      return rowGap;
  }
}

function getTextLineCount(text: string, width: number): number {
  const approximateCharactersPerLine = Math.max(12, Math.floor(width / 8));
  return Math.max(1, Math.ceil(text.length / approximateCharactersPerLine));
}

function getBlockHeight(block: LayoutBlock, width: number): number {
  switch (block.type) {
    case "heading":
      return getTextLineCount(block.text, width) * (block.level === 1 ? 40 : 30);
    case "text":
      return getTextLineCount(block.text, width) * 22 + 8;
    case "button":
      return getTextLineCount(block.label, width - 32) * 20 + 20;
    case "card":
      return (
        getTextLineCount(block.title, width - 32) * 22 +
        getTextLineCount(block.content, width - 32) * 20 +
        40
      );
    case "separator":
      return 12;
  }
}

function getBlockLabel(block: LayoutBlock): string {
  const defaultLabel = {
    heading: "Titre",
    text: "Texte",
    button: "Bouton",
    card: "Carte",
    separator: "Séparateur",
  }[block.type];
  return block.name ?? defaultLabel;
}

export function getLayoutSelectionId(selection: LayoutSelection): string {
  switch (selection.kind) {
    case "page":
      return selection.pageId;
    case "row":
      return selection.rowId;
    case "column":
      return selection.columnId;
    case "block":
      return selection.blockId;
    case "icon":
      return selection.iconObjectId;
  }
}

function getFlowPlacements(
  page: LayoutPage,
  breakpoint: CanvasBreakpoint,
): Map<string, LayoutRect> {
  const contentWidth = profileWidths[breakpoint] - 34;
  const trackWidth = (contentWidth - gridGap * 11) / 12;
  const placements = new Map<string, LayoutRect>();
  let pageY = 0;

  for (const row of page.rows) {
    const lines: Array<{
      columns: Array<{
        column: LayoutColumn;
        x: number;
        width: number;
        height: number;
      }>;
      height: number;
    }> = [];
    let activeLine = { columns: [] as typeof lines[number]["columns"], height: 90 };
    let occupiedTracks = 0;

    for (const column of row.columns) {
      const span =
        breakpoint === "mobile" ? 12 : column.span?.[breakpoint] ?? 12;
      if (occupiedTracks > 0 && occupiedTracks + span > 12) {
        lines.push(activeLine);
        activeLine = { columns: [], height: 90 };
        occupiedTracks = 0;
      }

      const x = occupiedTracks * (trackWidth + gridGap);
      const width = trackWidth * span + gridGap * (span - 1);
      const padding = getColumnPadding(column.spacing);
      const blocksHeight = column.blocks.reduce(
        (height, block) =>
          height +
          getBlockHeight(block, Math.max(1, width - padding * 2)) +
          getSpacingValue(block.spacing),
        0,
      );
      const height = Math.max(90, blocksHeight + padding * 2);
      activeLine.columns.push({ column, x, width, height });
      activeLine.height = Math.max(activeLine.height, height);
      occupiedTracks += span;
    }

    if (activeLine.columns.length > 0) {
      lines.push(activeLine);
    }

    let lineY = pageY;
    let rowHeight = 0;
    for (const line of lines) {
      for (const item of line.columns) {
        const { column, x, width, height } = item;
        const columnY = lineY;
        placements.set(column.id, {
          x,
          y: columnY,
          width,
          height,
        });

        const padding = getColumnPadding(column.spacing);
        let blockY = columnY + padding;
        for (const block of column.blocks) {
          const blockHeight = getBlockHeight(
            block,
            Math.max(1, width - padding * 2),
          );
          const blockRect = {
            x: x + padding,
            y: blockY,
            width: Math.max(1, width - padding * 2),
            height: blockHeight,
          };
          placements.set(block.id, blockRect);
          if (block.type === "button" && block.detachedIcon !== undefined) {
            placements.set(block.detachedIcon.id, {
              x: blockRect.x + 12,
              y: blockRect.y + (blockRect.height - 18) / 2,
              width: 18,
              height: 18,
            });
          }
          blockY += blockHeight + getSpacingValue(block.spacing);
        }
      }
      lineY += line.height + gridGap;
      rowHeight += line.height + gridGap;
    }
    if (lines.length > 0) {
      rowHeight -= gridGap;
    }

    placements.set(row.id, {
      x: 0,
      y: pageY,
      width: contentWidth,
      height: Math.max(90, rowHeight),
    });
    pageY += Math.max(90, rowHeight) + getRowGap(row.spacing);
  }

  return placements;
}

function getNodeMaxZIndex(page: LayoutPage): number {
  let max = -1;
  for (const row of page.rows) {
    max = Math.max(max, row.zIndex ?? -1);
    for (const column of row.columns) {
      max = Math.max(max, column.zIndex ?? -1);
      for (const block of column.blocks) {
        max = Math.max(max, block.zIndex ?? -1);
        if (block.type === "button" && block.detachedIcon !== undefined) {
          max = Math.max(max, block.detachedIcon.zIndex);
        }
      }
    }
  }
  return max;
}

function placementFromProfiles(
  profiles: Record<CanvasBreakpoint, Map<string, LayoutRect>>,
  id: string,
): Record<CanvasBreakpoint, LayoutRect> {
  return Object.fromEntries(
    canvasBreakpoints.map((breakpoint) => {
      const rect = profiles[breakpoint].get(id);
      if (rect === undefined) {
        throw new Error(`Free-layout geometry for "${id}" could not be initialized.`);
      }
      return [breakpoint, rect];
    }),
  ) as Record<CanvasBreakpoint, LayoutRect>;
}

function makeIconPlacement(
  blockPlacement: Record<CanvasBreakpoint, LayoutRect>,
): Record<CanvasBreakpoint, LayoutRect> {
  return Object.fromEntries(
    canvasBreakpoints.map((breakpoint) => {
      const rect = blockPlacement[breakpoint];
      return [
        breakpoint,
        {
          x: rect.x + 12,
          y: rect.y + (rect.height - 18) / 2,
          width: 18,
          height: 18,
        },
      ];
    }),
  ) as Record<CanvasBreakpoint, LayoutRect>;
}

function nextGeneratedId(): string {
  return `icon-${crypto.randomUUID()}`;
}

export function convertPageToFreeLayout(
  page: LayoutPage,
  createIconId: () => string = nextGeneratedId,
): LayoutPage {
  if (page.layoutMode === "free") {
    return ensureFreeLayoutGeometry(page);
  }

  const initializedPage = ensureFreeLayoutGeometry({
    ...page,
    layoutMode: "free",
  });
  let zIndex = getNodeMaxZIndex(initializedPage) + 1;

  const rows = initializedPage.rows.map((row) => {
    const columns = row.columns.map((column) => {
      const blocks = column.blocks.map((block) => {
        if (block.type !== "button" || block.iconId === undefined) {
          return block;
        }

        if (block.detachedIcon !== undefined) {
          throw new Error(
            `Le bouton « ${getBlockLabel(block)} » possède déjà une icône intégrée et détachée; conversion annulée pour éviter une perte.`,
          );
        }

        const { iconId, ...button } = block;
        if (button.placement === undefined) {
          throw new Error(
            `Free-layout geometry for button "${button.id}" could not be initialized.`,
          );
        }
        const detachedIcon: LayoutIconObject = {
          type: "icon",
          id: createIconId(),
          iconId,
          placement: makeIconPlacement(button.placement),
          zIndex: zIndex++,
        };
        return { ...button, detachedIcon };
      });
      return { ...column, blocks };
    });
    return { ...row, columns };
  });

  return { ...initializedPage, rows };
}

export function ensureFreeLayoutGeometry(page: LayoutPage): LayoutPage {
  if (page.layoutMode !== "free") {
    return page;
  }
  const profiles = Object.fromEntries(
    canvasBreakpoints.map((breakpoint) => [
      breakpoint,
      getFlowPlacements(page, breakpoint),
    ]),
  ) as Record<CanvasBreakpoint, Map<string, LayoutRect>>;
  let zIndex = getNodeMaxZIndex(page) + 1;
  let changed = false;

  const rows = page.rows.map((row) => {
    const rowPlacement =
      row.placement ?? placementFromProfiles(profiles, row.id);
    const rowZIndex = row.zIndex ?? zIndex++;
    const columns = row.columns.map((column) => {
      const columnPlacement =
        column.placement ?? placementFromProfiles(profiles, column.id);
      const columnZIndex = column.zIndex ?? zIndex++;
      const blocks = column.blocks.map((block) => {
        const placement =
          block.placement ?? placementFromProfiles(profiles, block.id);
        const blockZIndex = block.zIndex ?? zIndex++;
        changed ||= block.placement === undefined || block.zIndex === undefined;
        if (block.type !== "button" || block.detachedIcon === undefined) {
          return { ...block, placement, zIndex: blockZIndex };
        }
        const iconPlacement = block.detachedIcon.placement;
        const iconZIndex = block.detachedIcon.zIndex;
        return {
          ...block,
          placement,
          zIndex: blockZIndex,
          detachedIcon: {
            ...block.detachedIcon,
            placement: iconPlacement,
            zIndex: iconZIndex,
          },
        };
      });
      changed ||=
        column.placement === undefined || column.zIndex === undefined;
      return { ...column, placement: columnPlacement, zIndex: columnZIndex, blocks };
    });
    changed ||= row.placement === undefined || row.zIndex === undefined;
    return { ...row, placement: rowPlacement, zIndex: rowZIndex, columns };
  });

  return changed ? { ...page, rows } : page;
}

export function listFreeLayoutItems(
  page: LayoutPage,
  breakpoint: CanvasBreakpoint,
): FreeLayoutItem[] {
  const items: FreeLayoutItem[] = [];
  for (const row of page.rows) {
    if (row.placement !== undefined) {
      items.push({
        id: row.id,
        label: row.name ?? "Ligne",
        kind: "row",
        selection: { kind: "row", pageId: page.id, rowId: row.id },
        rect: row.placement[breakpoint],
        zIndex: row.zIndex ?? 0,
      });
    }
    for (const column of row.columns) {
      if (column.placement !== undefined) {
        items.push({
          id: column.id,
          label: column.name ?? "Colonne",
          kind: "column",
          selection: {
            kind: "column",
            pageId: page.id,
            rowId: row.id,
            columnId: column.id,
          },
          rect: column.placement[breakpoint],
          zIndex: column.zIndex ?? 0,
        });
      }
      for (const block of column.blocks) {
        if (block.placement !== undefined) {
          items.push({
            id: block.id,
            label: getBlockLabel(block),
            kind: "block",
            selection: {
              kind: "block",
              pageId: page.id,
              rowId: row.id,
              columnId: column.id,
              blockId: block.id,
            },
            rect: block.placement[breakpoint],
            zIndex: block.zIndex ?? 0,
          });
        }
        if (block.type === "button" && block.detachedIcon !== undefined) {
          items.push({
            id: block.detachedIcon.id,
            label: `${getBlockLabel(block)} — icône`,
            kind: "icon",
            selection: {
              kind: "icon",
              pageId: page.id,
              rowId: row.id,
              columnId: column.id,
              blockId: block.id,
              iconObjectId: block.detachedIcon.id,
            },
            rect: block.detachedIcon.placement[breakpoint],
            zIndex: block.detachedIcon.zIndex,
          });
        }
      }
    }
  }
  return items.sort((left, right) => left.zIndex - right.zIndex);
}

function updateSelectedNode(
  layout: LayoutConfig,
  selection: Exclude<LayoutSelection, { kind: "page" }>,
  changes: { placement?: ResponsiveLayoutPlacement; zIndex?: number },
): LayoutConfig {
  if (selection.kind === "row") {
    return updateRow(layout, selection.pageId, selection.rowId, (row) =>
      ({ ...row, ...changes }),
    );
  }
  if (selection.kind === "column") {
    return updateColumn(
      layout,
      selection.pageId,
      selection.rowId,
      selection.columnId,
      (column) => ({ ...column, ...changes }),
    );
  }
  return updateBlock(
    layout,
    selection.pageId,
    selection.rowId,
    selection.columnId,
    selection.blockId,
    (block) => {
      if (selection.kind === "block") {
      return { ...block, ...changes };
      }
      if (block.type !== "button" || block.detachedIcon?.id !== selection.iconObjectId) {
        throw new Error(`Detached icon "${selection.iconObjectId}" was not found.`);
      }
      return {
        ...block,
        detachedIcon: { ...block.detachedIcon, ...changes },
      };
    },
  );
}

export function updateLayoutNodeRect(
  layout: LayoutConfig,
  selection: Exclude<LayoutSelection, { kind: "page" }>,
  breakpoint: CanvasBreakpoint,
  rect: CanvasRect,
): LayoutConfig {
  const page = layout.pages.find(
    (candidate) => candidate.id === selection.pageId,
  );
  if (page === undefined) {
    throw new Error(`Page "${selection.pageId}" was not found.`);
  }
  const node = findNodeForSelection(page, selection);
  if (node.placement === undefined) {
    throw new Error(
      `Layout node "${getLayoutSelectionId(selection)}" has no free placement.`,
    );
  }
  return updateSelectedNode(layout, selection, {
    placement: updateResponsiveCanvasRect(node.placement, breakpoint, rect),
  });
}

export function updateLayoutNodeLayer(
  layout: LayoutConfig,
  page: LayoutPage,
  selection: Exclude<LayoutSelection, { kind: "page" }>,
  direction: LayerDirection,
): LayoutConfig {
  const items = listFreeLayoutItems(page, "desktop").map((item) => {
    const node = findNodeForSelection(page, item.selection);
    if (node.placement === undefined || node.zIndex === undefined) {
      throw new Error(`Free-layout node "${item.id}" is missing placement or zIndex.`);
    }
    return {
      id: item.id,
      payload: item.selection,
      placement: node.placement,
      zIndex: node.zIndex,
    } satisfies CanvasItem<LayoutSelection>;
  });
  const moved = moveCanvasItemLayer(items, getLayoutSelectionId(selection), direction);
  return moved.reduce((nextLayout, item) => {
    const itemSelection = item.payload;
    if (itemSelection.kind === "page") {
      return nextLayout;
    }
    return updateSelectedNode(nextLayout, itemSelection, {
      zIndex: item.zIndex,
    });
  }, layout);
}

function findNodeForSelection(
  page: LayoutPage,
  selection: LayoutSelection,
): LayoutRow | LayoutColumn | LayoutBlock | LayoutIconObject {
  if (selection.kind === "page") {
    throw new Error("The page itself is not a free-layout item.");
  }
  const row = page.rows.find((candidate) => candidate.id === selection.rowId);
  if (row === undefined) {
    throw new Error(`Row "${selection.rowId}" was not found.`);
  }
  if (selection.kind === "row") {
    return row;
  }
  const column = row.columns.find((candidate) => candidate.id === selection.columnId);
  if (column === undefined) {
    throw new Error(`Column "${selection.columnId}" was not found.`);
  }
  if (selection.kind === "column") {
    return column;
  }
  const block = column.blocks.find((candidate) => candidate.id === selection.blockId);
  if (block === undefined) {
    throw new Error(`Block "${selection.blockId}" was not found.`);
  }
  if (selection.kind === "block") {
    return block;
  }
  if (block.type !== "button" || block.detachedIcon?.id !== selection.iconObjectId) {
    throw new Error(`Detached icon "${selection.iconObjectId}" was not found.`);
  }
  return block.detachedIcon;
}

export function setButtonIcon(
  layout: LayoutConfig,
  page: LayoutPage,
  rowId: string,
  columnId: string,
  blockId: string,
  iconId: LayoutIconId | null,
): LayoutConfig {
  return updateBlock(layout, page.id, rowId, columnId, blockId, (block) => {
    if (block.type !== "button") {
      return block;
    }
    if (iconId === null) {
      const next = { ...block };
      delete next.iconId;
      delete next.detachedIcon;
      return next;
    }
    if (page.layoutMode !== "free") {
      const next = { ...block, iconId };
      delete next.detachedIcon;
      return next;
    }
    if (block.detachedIcon !== undefined) {
      const next = { ...block };
      delete next.iconId;
      return {
        ...next,
        detachedIcon: { ...block.detachedIcon, iconId },
      };
    }
    if (block.placement === undefined) {
      throw new Error(`Button "${blockId}" has no free placement.`);
    }
    const rects = block.placement;
    const placement = Object.fromEntries(
      canvasBreakpoints.map((breakpoint) => {
        const rect = rects[breakpoint];
        return [
          breakpoint,
          {
            x: rect.x + 12,
            y: rect.y + (rect.height - 18) / 2,
            width: 18,
            height: 18,
          },
        ];
      }),
    ) as LayoutIconObject["placement"];
    return {
      ...block,
      detachedIcon: {
        type: "icon",
        id: nextGeneratedId(),
        iconId,
        placement,
        zIndex: getNodeMaxZIndex(page) + 1,
      },
    };
  });
}

export function deleteDetachedIcon(
  layout: LayoutConfig,
  selection: Extract<LayoutSelection, { kind: "icon" }>,
): LayoutConfig {
  return updateBlock(
    layout,
    selection.pageId,
    selection.rowId,
    selection.columnId,
    selection.blockId,
    (block) => {
      if (block.type !== "button" || block.detachedIcon?.id !== selection.iconObjectId) {
        throw new Error(`Detached icon "${selection.iconObjectId}" was not found.`);
      }
      const next = { ...block };
      delete next.detachedIcon;
      return next;
    },
  );
}

export function getNearestFreeLayoutDistance(
  rect: CanvasRect,
  items: readonly FreeLayoutItem[],
  activeId: string,
): { id: string; xGap: number; yGap: number } | null {
  let nearest: { id: string; xGap: number; yGap: number; score: number } | null =
    null;
  for (const item of items) {
    if (item.id === activeId) {
      continue;
    }
    const distance = measureCanvasRectDistance(rect, item.rect);
    const score = Math.abs(distance.x.gap) + Math.abs(distance.y.gap);
    if (nearest === null || score < nearest.score) {
      nearest = {
        id: item.id,
        xGap: distance.x.gap,
        yGap: distance.y.gap,
        score,
      };
    }
  }
  return nearest === null
    ? null
    : { id: nearest.id, xGap: nearest.xGap, yGap: nearest.yGap };
}

export function getFreeCanvasWidth(breakpoint: CanvasBreakpoint): number {
  return profileWidths[breakpoint];
}

export function getFreeCanvasHeight(
  page: LayoutPage,
  breakpoint: CanvasBreakpoint,
): number {
  return listFreeLayoutItems(page, breakpoint).reduce(
    (height, item) => Math.max(height, item.rect.y + item.rect.height + 24),
    320,
  );
}
