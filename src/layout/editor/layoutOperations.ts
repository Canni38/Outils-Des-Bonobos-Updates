import type {
  ButtonBlock,
  CardBlock,
  HeadingBlock,
  LayoutBlock,
  LayoutColumn,
  LayoutConfig,
  LayoutPage,
  LayoutRow,
  SeparatorBlock,
  TextBlock,
} from "../schema/types.ts";

export type LayoutSelection =
  | { kind: "page"; pageId: string }
  | { kind: "row"; pageId: string; rowId: string }
  | {
      kind: "column";
      pageId: string;
      rowId: string;
      columnId: string;
    }
  | {
      kind: "block";
      pageId: string;
      rowId: string;
      columnId: string;
      blockId: string;
    }
  | {
      kind: "icon";
      pageId: string;
      rowId: string;
      columnId: string;
      blockId: string;
      iconObjectId: string;
    };

export type NewBlockType = LayoutBlock["type"];

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function requirePage(layout: LayoutConfig, pageId: string): LayoutPage {
  const page = layout.pages.find((candidate) => candidate.id === pageId);
  if (page === undefined) {
    throw new Error(`Page "${pageId}" was not found.`);
  }
  return page;
}

function replacePage(
  layout: LayoutConfig,
  pageId: string,
  update: (page: LayoutPage) => LayoutPage,
): LayoutConfig {
  let pageFound = false;
  const pages = layout.pages.map((page) => {
    if (page.id !== pageId) {
      return page;
    }
    pageFound = true;
    return update(page);
  });

  if (!pageFound) {
    throw new Error(`Page "${pageId}" was not found.`);
  }
  return { ...layout, pages };
}

function reflowColumns(columns: LayoutColumn[]): LayoutColumn[] {
  const baseSpan = Math.floor(12 / columns.length);
  const remainingSpans = 12 % columns.length;

  return columns.map((column, index) => {
    const span = baseSpan + (index < remainingSpans ? 1 : 0);
    return {
      ...column,
      span: {
        mobile: column.span?.mobile ?? 12,
        tablet: span,
        desktop: span,
      },
    };
  });
}

function createBlock(type: NewBlockType): LayoutBlock {
  const id = createId(type);
  const common = {
    id,
    name: type === "heading"
      ? "Titre"
      : type === "text"
        ? "Texte"
        : type === "button"
          ? "Bouton"
          : type === "card"
            ? "Carte"
            : "Séparateur",
    alignment: "left" as const,
    spacing: "medium" as const,
  };

  switch (type) {
    case "heading": {
      const block: HeadingBlock = {
        ...common,
        type,
        text: "Nouveau titre",
        level: 2,
      };
      return block;
    }
    case "text": {
      const block: TextBlock = {
        ...common,
        type,
        text: "Nouveau texte",
        tone: "default",
      };
      return block;
    }
    case "button": {
      const block: ButtonBlock = {
        ...common,
        type,
        label: "Nouveau bouton",
        actionId: "demo.show-welcome",
        variant: "primary",
      };
      return block;
    }
    case "card": {
      const block: CardBlock = {
        ...common,
        type,
        title: "Nouvelle carte",
        content: "Contenu de la carte",
      };
      return block;
    }
    case "separator": {
      const block: SeparatorBlock = { ...common, type };
      return block;
    }
  }
}

function requireRow(page: LayoutPage, rowId: string): LayoutRow {
  const row = page.rows.find((candidate) => candidate.id === rowId);
  if (row === undefined) {
    throw new Error(`Row "${rowId}" was not found.`);
  }
  return row;
}

function requireColumn(row: LayoutRow, columnId: string): LayoutColumn {
  const column = row.columns.find((candidate) => candidate.id === columnId);
  if (column === undefined) {
    throw new Error(`Column "${columnId}" was not found.`);
  }
  return column;
}

export function updatePage(
  layout: LayoutConfig,
  pageId: string,
  update: (page: LayoutPage) => LayoutPage,
): LayoutConfig {
  return replacePage(layout, pageId, update);
}

export function updateRow(
  layout: LayoutConfig,
  pageId: string,
  rowId: string,
  update: (row: LayoutRow) => LayoutRow,
): LayoutConfig {
  return replacePage(layout, pageId, (page) => {
    let rowFound = false;
    const rows = page.rows.map((row) => {
      if (row.id !== rowId) {
        return row;
      }
      rowFound = true;
      return update(row);
    });

    if (!rowFound) {
      throw new Error(`Row "${rowId}" was not found.`);
    }
    return { ...page, rows };
  });
}

export function updateColumn(
  layout: LayoutConfig,
  pageId: string,
  rowId: string,
  columnId: string,
  update: (column: LayoutColumn) => LayoutColumn,
): LayoutConfig {
  return updateRow(layout, pageId, rowId, (row) => {
    let columnFound = false;
    const columns = row.columns.map((column) => {
      if (column.id !== columnId) {
        return column;
      }
      columnFound = true;
      return update(column);
    });

    if (!columnFound) {
      throw new Error(`Column "${columnId}" was not found.`);
    }
    return { ...row, columns };
  });
}

export function updateBlock(
  layout: LayoutConfig,
  pageId: string,
  rowId: string,
  columnId: string,
  blockId: string,
  update: (block: LayoutBlock) => LayoutBlock,
): LayoutConfig {
  return updateColumn(layout, pageId, rowId, columnId, (column) => {
    let blockFound = false;
    const blocks = column.blocks.map((block) => {
      if (block.id !== blockId) {
        return block;
      }
      blockFound = true;
      return update(block);
    });

    if (!blockFound) {
      throw new Error(`Block "${blockId}" was not found.`);
    }
    return { ...column, blocks };
  });
}

export function addPage(
  layout: LayoutConfig,
): { layout: LayoutConfig; pageId: string } {
  if (layout.pages.length >= 100) {
    throw new Error("A layout cannot contain more than 100 pages.");
  }
  const pageId = createId("page");
  const page: LayoutPage = {
    id: pageId,
    title: "Nouvelle page",
    order: Math.max(-1, ...layout.pages.map(({ order }) => order)) + 1,
    layoutMode: "flow",
    rows: [],
  };

  return {
    pageId,
    layout: { ...layout, pages: [...layout.pages, page] },
  };
}

export function addRow(layout: LayoutConfig, pageId: string): LayoutConfig {
  if (requirePage(layout, pageId).rows.length >= 100) {
    throw new Error("A page cannot contain more than 100 rows.");
  }
  const row: LayoutRow = {
    type: "row",
    id: createId("row"),
    name: "Nouvelle ligne",
    spacing: "medium",
    columns: [
      {
        type: "column",
        id: createId("column"),
        name: "Nouvelle colonne",
        spacing: "none",
        span: { mobile: 12, tablet: 12, desktop: 12 },
        blocks: [],
      },
    ],
  };
  return replacePage(layout, pageId, (page) => ({
    ...page,
    rows: [...page.rows, row],
  }));
}

export function deleteRow(
  layout: LayoutConfig,
  pageId: string,
  rowId: string,
): LayoutConfig {
  const page = requirePage(layout, pageId);
  if (!page.rows.some((row) => row.id === rowId)) {
    throw new Error(`Row "${rowId}" was not found.`);
  }
  return replacePage(layout, pageId, (currentPage) => ({
    ...currentPage,
    rows: currentPage.rows.filter((row) => row.id !== rowId),
  }));
}

export function addColumn(
  layout: LayoutConfig,
  pageId: string,
  rowId: string,
): LayoutConfig {
  const layoutMode = requirePage(layout, pageId).layoutMode;
  return updateRow(layout, pageId, rowId, (row) => {
    if (layoutMode === "flow" && row.columns.length >= 12) {
      throw new Error("A row cannot contain more than 12 columns.");
    }

    const column: LayoutColumn = {
      type: "column",
      id: createId("column"),
      name: `Colonne ${row.columns.length + 1}`,
      spacing: "none",
      ...(layoutMode === "flow"
        ? { span: { mobile: 12, tablet: 1, desktop: 1 } }
        : {}),
      blocks: [],
    };
    const columns = [
      ...row.columns,
      column,
    ];
    return {
      ...row,
      columns:
        layoutMode === "flow" ? reflowColumns(columns) : columns,
    };
  });
}

export function deleteColumn(
  layout: LayoutConfig,
  pageId: string,
  rowId: string,
  columnId: string,
): LayoutConfig {
  return updateRow(layout, pageId, rowId, (row) => {
    requireColumn(row, columnId);
    if (row.columns.length === 1) {
      throw new Error("A row must keep at least one column.");
    }
    return {
      ...row,
      columns: row.columns.filter((column) => column.id !== columnId),
    };
  });
}

export function addBlock(
  layout: LayoutConfig,
  pageId: string,
  rowId: string,
  columnId: string,
  type: NewBlockType,
): LayoutConfig {
  return updateColumn(layout, pageId, rowId, columnId, (column) => {
    if (column.blocks.length >= 100) {
      throw new Error("A column cannot contain more than 100 components.");
    }
    return { ...column, blocks: [...column.blocks, createBlock(type)] };
  });
}

export function deleteBlock(
  layout: LayoutConfig,
  pageId: string,
  rowId: string,
  columnId: string,
  blockId: string,
): LayoutConfig {
  return updateColumn(layout, pageId, rowId, columnId, (column) => {
    if (!column.blocks.some((block) => block.id === blockId)) {
      throw new Error(`Block "${blockId}" was not found.`);
    }
    return {
      ...column,
      blocks: column.blocks.filter((block) => block.id !== blockId),
    };
  });
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) {
    return items;
  }
  const next = items.slice();
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

export function moveRow(
  layout: LayoutConfig,
  pageId: string,
  activeRowId: string,
  targetRowId: string,
): LayoutConfig {
  return replacePage(layout, pageId, (page) => {
    const fromIndex = page.rows.findIndex((row) => row.id === activeRowId);
    const toIndex = page.rows.findIndex((row) => row.id === targetRowId);
    if (fromIndex < 0 || toIndex < 0) {
      throw new Error("Cannot move a row that is not on the current page.");
    }
    return { ...page, rows: moveItem(page.rows, fromIndex, toIndex) };
  });
}

export function moveColumn(
  layout: LayoutConfig,
  pageId: string,
  activeRowId: string,
  activeColumnId: string,
  targetRowId: string,
  targetColumnId?: string,
): LayoutConfig {
  const page = requirePage(layout, pageId);
  const sourceRow = requireRow(page, activeRowId);
  const sourceColumn = requireColumn(sourceRow, activeColumnId);
  const targetRow = requireRow(page, targetRowId);

  if (sourceRow.id === targetRow.id) {
    if (targetColumnId === undefined) {
      return layout;
    }
    if (targetColumnId === activeColumnId) {
      return layout;
    }
    const fromIndex = sourceRow.columns.findIndex(
      (column) => column.id === activeColumnId,
    );
    const toIndex = sourceRow.columns.findIndex(
      (column) => column.id === targetColumnId,
    );
    if (toIndex < 0) {
      throw new Error(`Column "${targetColumnId}" was not found.`);
    }
    return updateRow(layout, pageId, activeRowId, (row) => ({
      ...row,
      columns: moveItem(row.columns, fromIndex, toIndex),
    }));
  }

  if (sourceRow.columns.length === 1) {
    throw new Error("Cannot move the last column out of a row.");
  }
  if (page.layoutMode === "flow" && targetRow.columns.length >= 12) {
    throw new Error("The target row already has 12 columns.");
  }

  const targetIndex =
    targetColumnId === undefined
      ? targetRow.columns.length
      : targetRow.columns.findIndex((column) => column.id === targetColumnId);
  if (targetIndex < 0) {
    throw new Error(`Column "${targetColumnId}" was not found.`);
  }

  return replacePage(layout, pageId, (currentPage) => ({
    ...currentPage,
    rows: currentPage.rows.map((row) => {
      if (row.id === sourceRow.id) {
        return {
          ...row,
          columns: row.columns.filter((column) => column.id !== sourceColumn.id),
        };
      }
      if (row.id === targetRow.id) {
        const columns = row.columns.slice();
        columns.splice(targetIndex, 0, sourceColumn);
        return { ...row, columns };
      }
      return row;
    }),
  }));
}

interface LocatedBlock {
  rowId: string;
  columnId: string;
  block: LayoutBlock;
}

function locateBlock(
  page: LayoutPage,
  blockId: string,
): LocatedBlock {
  for (const row of page.rows) {
    for (const column of row.columns) {
      const block = column.blocks.find((candidate) => candidate.id === blockId);
      if (block !== undefined) {
        return { rowId: row.id, columnId: column.id, block };
      }
    }
  }
  throw new Error(`Block "${blockId}" was not found on the page.`);
}

export function moveBlock(
  layout: LayoutConfig,
  pageId: string,
  activeBlockId: string,
  targetRowId: string,
  targetColumnId: string,
  targetBlockId?: string,
): LayoutConfig {
  const page = requirePage(layout, pageId);
  const source = locateBlock(page, activeBlockId);
  const targetRow = requireRow(page, targetRowId);
  const targetColumn = requireColumn(targetRow, targetColumnId);

  if (source.columnId === targetColumnId) {
    if (targetBlockId === activeBlockId) {
      return layout;
    }
    const fromIndex = targetColumn.blocks.findIndex(
      (block) => block.id === activeBlockId,
    );
    const toIndex =
      targetBlockId === undefined
        ? targetColumn.blocks.length - 1
        : targetColumn.blocks.findIndex((block) => block.id === targetBlockId);
    if (toIndex < 0) {
      throw new Error(`Block "${targetBlockId}" was not found.`);
    }
    return updateColumn(layout, pageId, targetRowId, targetColumnId, (column) => ({
      ...column,
      blocks: moveItem(column.blocks, fromIndex, toIndex),
    }));
  }

  if (targetColumn.blocks.length >= 100) {
    throw new Error("The target column already has 100 components.");
  }

  const insertIndex =
    targetBlockId === undefined
      ? targetColumn.blocks.length
      : targetColumn.blocks.findIndex((block) => block.id === targetBlockId);
  if (insertIndex < 0) {
    throw new Error(`Block "${targetBlockId}" was not found.`);
  }

  return replacePage(layout, pageId, (currentPage) => ({
    ...currentPage,
    rows: currentPage.rows.map((row) => ({
      ...row,
      columns: row.columns.map((column) => {
        if (column.id === source.columnId) {
          return {
            ...column,
            blocks: column.blocks.filter((block) => block.id !== activeBlockId),
          };
        }
        if (column.id === targetColumnId) {
          const blocks = column.blocks.slice();
          blocks.splice(insertIndex, 0, source.block);
          return { ...column, blocks };
        }
        return column;
      }),
    })),
  }));
}
