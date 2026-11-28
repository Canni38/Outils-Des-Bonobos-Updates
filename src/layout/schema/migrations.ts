import type {
  LayoutBlock,
  LayoutBlockV1,
  LayoutConfig,
  LayoutConfigV2,
  LayoutConfigV1,
  LayoutRow,
} from "./types.ts";

function getDefaultBlockName(type: LayoutBlockV1["type"]): string {
  switch (type) {
    case "heading":
      return "Titre";
    case "text":
      return "Texte";
    case "button":
      return "Bouton";
  }
}

function migrateBlock(block: LayoutBlockV1): LayoutBlock {
  const common = {
    id: block.id,
    name: getDefaultBlockName(block.type),
    alignment: "left" as const,
    spacing: "medium" as const,
  };

  switch (block.type) {
    case "heading":
      return { ...common, ...block };
    case "text":
      return { ...common, ...block };
    case "button":
      return { ...common, ...block };
  }
}

export function migrateLayoutV1ToV2(layout: LayoutConfigV1): LayoutConfigV2 {
  return {
    schemaVersion: 2,
    layoutId: layout.layoutId,
    pages: layout.pages.map((page) => ({
      ...page,
      rows: page.rows.map((row, rowIndex): LayoutRow => ({
        ...row,
        name: `Ligne ${rowIndex + 1}`,
        spacing: "medium",
        columns: row.columns.map((column, columnIndex) => ({
          ...column,
          name: `Colonne ${columnIndex + 1}`,
          spacing: "none",
          blocks: column.blocks.map(migrateBlock),
        })),
      })),
    })),
  };
}

export function migrateLayoutV2ToV3(layout: LayoutConfigV2): LayoutConfig {
  return {
    schemaVersion: 3,
    layoutId: layout.layoutId,
    pages: layout.pages.map((page) => ({
      ...page,
      layoutMode: "flow",
    })),
  };
}
