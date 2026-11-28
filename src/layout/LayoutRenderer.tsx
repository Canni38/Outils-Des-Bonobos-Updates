import type { CSSProperties } from "react";
import {
  LayoutBlockContent,
  LayoutIconView,
  type LayoutActionHandler,
} from "./components/registry.tsx";
import type {
  LayoutColumn,
  LayoutConfig,
  LayoutIconObject,
  LayoutPage,
} from "./schema/types.ts";
import type { CanvasBreakpoint } from "./engine/types.ts";
import { validateLayoutConfig } from "./schema/validateLayoutConfig.ts";
import "./layout.css";

const responsiveProfiles = ["mobile", "tablet", "desktop"] as const;

interface LayoutRendererProps {
  layout: unknown;
  pageId?: string;
  onAction?: LayoutActionHandler;
  responsiveMode?: CanvasBreakpoint;
}

type ResponsiveColumnStyle = CSSProperties & {
  "--layout-span-mobile": number;
  "--layout-span-tablet": number;
  "--layout-span-desktop": number;
};

type ResponsiveFreeStyle = CSSProperties & {
  "--layout-free-x-mobile": string;
  "--layout-free-y-mobile": string;
  "--layout-free-width-mobile": string;
  "--layout-free-height-mobile": string;
  "--layout-free-x-tablet": string;
  "--layout-free-y-tablet": string;
  "--layout-free-width-tablet": string;
  "--layout-free-height-tablet": string;
  "--layout-free-x-desktop": string;
  "--layout-free-y-desktop": string;
  "--layout-free-width-desktop": string;
  "--layout-free-height-desktop": string;
};

type ResponsiveFreePageStyle = CSSProperties & {
  "--layout-free-page-height-mobile": string;
  "--layout-free-page-height-tablet": string;
  "--layout-free-page-height-desktop": string;
};

type RuntimeFreeItem =
  | {
      id: string;
      kind: "block";
      zIndex: number;
      block: LayoutPage["rows"][number]["columns"][number]["blocks"][number];
      style: ResponsiveFreeStyle;
    }
  | {
      id: string;
      kind: "icon";
      zIndex: number;
      icon: LayoutIconObject;
      style: ResponsiveFreeStyle;
    };

function getFreeStyle(
  node: { placement?: LayoutColumn["placement"]; zIndex?: number },
): ResponsiveFreeStyle | null {
  if (node.placement === undefined) {
    return null;
  }
  const profileStyles = Object.fromEntries(
    responsiveProfiles.flatMap((profile) => {
      const rect = node.placement?.[profile];
      if (rect === undefined) {
        return [];
      }
      return [
        [`--layout-free-x-${profile}`, `${rect.x}px`],
        [`--layout-free-y-${profile}`, `${rect.y}px`],
        [`--layout-free-width-${profile}`, `${rect.width}px`],
        [`--layout-free-height-${profile}`, `${rect.height}px`],
      ];
    }),
  );
  return {
    ...profileStyles,
    zIndex: node.zIndex ?? 0,
  } as ResponsiveFreeStyle;
}

function getFreePageStyle(page: LayoutPage): ResponsiveFreePageStyle {
  const getBottom = (profile: CanvasBreakpoint) =>
    page.rows.reduce((maxBottom, row) => {
      const rowBottom =
        row.placement === undefined
          ? 0
          : row.placement[profile].y + row.placement[profile].height;
      const columnsBottom = row.columns.reduce(
        (columnMax, column) =>
          column.placement === undefined
            ? columnMax
            : Math.max(
                columnMax,
                column.placement[profile].y +
                  column.placement[profile].height,
              ),
        rowBottom,
      );
      const blocksBottom = row.columns.reduce(
        (columnMax, column) =>
          column.blocks.reduce((blockMax, block) => {
            const blockRect = block.placement?.[profile];
            const iconRect =
              block.type === "button"
                ? block.detachedIcon?.placement[profile]
                : undefined;
            return Math.max(
              blockMax,
              blockRect === undefined ? 0 : blockRect.y + blockRect.height,
              iconRect === undefined ? 0 : iconRect.y + iconRect.height,
            );
          }, columnMax),
        columnsBottom,
      );
      return Math.max(maxBottom, blocksBottom);
    }, 320);
  return {
    "--layout-free-page-height-mobile": `${getBottom("mobile") + 24}px`,
    "--layout-free-page-height-tablet": `${getBottom("tablet") + 24}px`,
    "--layout-free-page-height-desktop": `${getBottom("desktop") + 24}px`,
  };
}

function getFreeItems(page: LayoutPage): RuntimeFreeItem[] {
  const items: RuntimeFreeItem[] = [];
  for (const row of page.rows) {
    for (const column of row.columns) {
      for (const block of column.blocks) {
        const style = getFreeStyle(block);
        if (style !== null) {
          items.push({
            id: block.id,
            kind: "block",
            zIndex: block.zIndex ?? 0,
            block,
            style,
          });
        }
        if (block.type === "button" && block.detachedIcon !== undefined) {
          const iconStyle = getFreeStyle(block.detachedIcon);
          if (iconStyle !== null) {
            items.push({
              id: block.detachedIcon.id,
              kind: "icon",
              zIndex: block.detachedIcon.zIndex,
              icon: block.detachedIcon,
              style: iconStyle,
            });
          }
        }
      }
    }
  }
  return items.sort((left, right) => left.zIndex - right.zIndex);
}

function renderFreePage(
  page: LayoutPage,
  responsiveMode?: CanvasBreakpoint,
  onAction?: LayoutActionHandler,
) {
  const pageStyle = getFreePageStyle(page);
  return (
    <section
      aria-label={page.title}
      className={`layout-page layout-page--free${responsiveMode === undefined ? "" : ` layout-page--${responsiveMode}`}`}
      style={pageStyle}
    >
      {getFreeItems(page).map((item) => (
        <div
          className={`layout-free-item layout-free-item--${item.kind}`}
          key={item.id}
          style={item.style}
        >
          {item.kind === "block" ? (
            <LayoutBlockContent
              block={item.block}
              detachedIconRendering="separate"
              onAction={onAction}
            />
          ) : (
            <LayoutIconView iconId={item.icon.iconId} />
          )}
        </div>
      ))}
    </section>
  );
}

function renderColumn(column: LayoutColumn, onAction?: LayoutActionHandler) {
  const style: ResponsiveColumnStyle = {
    "--layout-span-mobile": column.span?.mobile ?? 12,
    "--layout-span-tablet": column.span?.tablet ?? 12,
    "--layout-span-desktop": column.span?.desktop ?? 12,
  };

  return (
    <div
      className="layout-grid-column"
      data-layout-alignment={column.alignment ?? "left"}
      data-layout-spacing={column.spacing ?? "none"}
      key={column.id}
      style={style}
    >
      {column.blocks.map((block) => (
        <LayoutBlockContent key={block.id} block={block} onAction={onAction} />
      ))}
    </div>
  );
}

function getPage(layout: LayoutConfig, pageId?: string) {
  if (pageId !== undefined) {
    return layout.pages.find((page) => page.id === pageId);
  }

  return layout.pages.slice().sort((left, right) => left.order - right.order)[0];
}

export function LayoutRenderer({
  layout,
  pageId,
  onAction,
  responsiveMode,
}: LayoutRendererProps) {
  const validation = validateLayoutConfig(layout);
  if (!validation.valid) {
    return (
      <div className="layout-renderer-error" role="alert">
        <p>La configuration de la mise en page est invalide.</p>
        <ul>
          {validation.issues.map((issue, index) => (
            <li key={`${issue.path}-${index}`}>
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const page = getPage(validation.value, pageId);
  if (page === undefined) {
    return (
      <p className="layout-renderer-error" role="status">
        La page demandée est introuvable.
      </p>
    );
  }

  const responsiveClass =
    responsiveMode === undefined ? "" : ` layout-page--${responsiveMode}`;

  if (page.layoutMode === "free") {
    return renderFreePage(page, responsiveMode, onAction);
  }

  return (
    <section
      className={`layout-page${responsiveClass}`}
      aria-label={page.title}
    >
      {page.rows.map((row) => (
        <div
          className="layout-grid-row"
          data-layout-spacing={row.spacing ?? "medium"}
          key={row.id}
        >
          {row.columns.map((column) => renderColumn(column, onAction))}
        </div>
      ))}
    </section>
  );
}
