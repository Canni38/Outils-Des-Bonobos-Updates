import type { CSSProperties } from "react";
import { useState } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LayoutBlockContent } from "../components/registry.tsx";
import type { CanvasRect } from "../engine/types.ts";
import type {
  LayoutBlock,
  LayoutColumn,
  LayoutPage,
  LayoutRow,
} from "../schema/types.ts";
import type { LayoutSelection } from "./layoutOperations.ts";
import { FreeLayoutCanvas } from "./FreeLayoutCanvas.tsx";

type DevicePreview = "mobile" | "tablet" | "desktop";

export type EditorDndData =
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
    };

export interface EditorCanvasProps {
  page: LayoutPage;
  selected: LayoutSelection | null;
  device: DevicePreview;
  onSelect: (selection: LayoutSelection) => void;
  onDeleteRow: (rowId: string) => void;
  onAddColumn: (rowId: string) => void;
  onDeleteColumn: (rowId: string, columnId: string) => void;
  onDeleteBlock: (rowId: string, columnId: string, blockId: string) => void;
  onMove: (active: EditorDndData, target: EditorDndData) => void;
  onTransformStart: () => void;
  onTransformPreview: (
    selection: Exclude<LayoutSelection, { kind: "page" }>,
    rect: CanvasRect,
  ) => void;
  onTransformCommit: (
    selection: Exclude<LayoutSelection, { kind: "page" }>,
    rect: CanvasRect,
  ) => void;
  onTransformCancel: () => void;
}

type ResponsiveColumnStyle = CSSProperties & {
  "--layout-span-mobile": number;
  "--layout-span-tablet": number;
  "--layout-span-desktop": number;
};

function isEditorDndData(value: unknown): value is EditorDndData {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }

  if (
    !("pageId" in value) ||
    typeof value.pageId !== "string" ||
    !("rowId" in value) ||
    typeof value.rowId !== "string"
  ) {
    return false;
  }

  if (value.kind === "row") {
    return true;
  }
  if (
    value.kind === "column" &&
    "columnId" in value &&
    typeof value.columnId === "string"
  ) {
    return true;
  }
  return (
    value.kind === "block" &&
    "columnId" in value &&
    typeof value.columnId === "string" &&
    "blockId" in value &&
    typeof value.blockId === "string"
  );
}

function getSelectionId(selection: LayoutSelection | null): string | null {
  if (selection === null) {
    return null;
  }
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

function getRowLabel(row: LayoutRow): string {
  return row.name ?? "Ligne";
}

function getColumnLabel(column: LayoutColumn): string {
  return column.name ?? "Colonne";
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

function getDragLabel(data: EditorDndData | null): string {
  if (data === null) {
    return "";
  }
  return data.kind === "row"
    ? "Déplacement d’une ligne"
    : data.kind === "column"
      ? "Déplacement d’une colonne"
      : "Déplacement d’un composant";
}

interface SortableBlockProps {
  pageId: string;
  rowId: string;
  columnId: string;
  block: LayoutBlock;
  selected: boolean;
  onSelect: (selection: LayoutSelection) => void;
  onDelete: () => void;
}

function SortableBlock({
  pageId,
  rowId,
  columnId,
  block,
  selected,
  onSelect,
  onDelete,
}: SortableBlockProps) {
  const {
    attributes,
    isDragging,
    isOver,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: block.id,
    data: { kind: "block", pageId, rowId, columnId, blockId: block.id },
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      className={[
        "layout-editor-block",
        selected ? "is-selected" : "",
        isOver ? "is-drop-target" : "",
      ].filter(Boolean).join(" ")}
      ref={setNodeRef}
      style={style}
        onClick={(event) => {
          event.stopPropagation();
          onSelect({ kind: "block", pageId, rowId, columnId, blockId: block.id });
        }}
    >
      <div className="layout-editor-node-toolbar">
        <button
          aria-label={`Déplacer ${getBlockLabel(block)}`}
          className="layout-editor-drag-handle"
          type="button"
          {...attributes}
          {...listeners}
        >
          ::
        </button>
        <button
          className="layout-editor-node-select"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect({
              kind: "block",
              pageId,
              rowId,
              columnId,
              blockId: block.id,
            });
          }}
        >
          {getBlockLabel(block)}
        </button>
        <button
          aria-label={`Supprimer ${getBlockLabel(block)}`}
          className="layout-editor-delete"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          Supprimer
        </button>
      </div>
      <div className="layout-editor-block-preview">
        <LayoutBlockContent block={block} editorMode />
      </div>
    </div>
  );
}

interface SortableColumnProps {
  pageId: string;
  rowId: string;
  column: LayoutColumn;
  selected: boolean;
  canDelete: boolean;
  selectedNodeId: string | null;
  onSelect: (selection: LayoutSelection) => void;
  onDelete: () => void;
  onDeleteBlock: (blockId: string) => void;
}

function SortableColumn({
  pageId,
  rowId,
  column,
  selected,
  canDelete,
  selectedNodeId,
  onSelect,
  onDelete,
  onDeleteBlock,
}: SortableColumnProps) {
  const {
    attributes,
    isDragging,
    isOver,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: column.id,
    data: { kind: "column", pageId, rowId, columnId: column.id },
  });
  const style: ResponsiveColumnStyle = {
    "--layout-span-mobile": column.span?.mobile ?? 12,
    "--layout-span-tablet": column.span?.tablet ?? 12,
    "--layout-span-desktop": column.span?.desktop ?? 12,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      className={[
        "layout-grid-column",
        "layout-editor-column",
        selected ? "is-selected" : "",
        isOver ? "is-drop-target" : "",
      ].filter(Boolean).join(" ")}
      data-layout-alignment={column.alignment ?? "left"}
      data-layout-spacing={column.spacing ?? "none"}
      ref={setNodeRef}
      style={style}
      onClick={() =>
        onSelect({ kind: "column", pageId, rowId, columnId: column.id })
      }
    >
      <div className="layout-editor-node-toolbar">
        <button
          aria-label={`Déplacer ${getColumnLabel(column)}`}
          className="layout-editor-drag-handle"
          type="button"
          {...attributes}
          {...listeners}
        >
          ::
        </button>
        <button
          className="layout-editor-node-select"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect({
              kind: "column",
              pageId,
              rowId,
              columnId: column.id,
            });
          }}
        >
          {getColumnLabel(column)}
        </button>
        <button
          aria-label={`Supprimer ${getColumnLabel(column)}`}
          className="layout-editor-delete"
          type="button"
          disabled={!canDelete}
          title={canDelete ? "Supprimer la colonne" : "Une ligne doit conserver une colonne"}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          Supprimer
        </button>
      </div>
      <SortableContext
        items={column.blocks.map((block) => block.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="layout-editor-block-list">
          {column.blocks.length === 0 && (
            <p className="layout-editor-empty">
              Aucun composant — sélectionnez un élément dans la bibliothèque.
            </p>
          )}
          {column.blocks.map((block) => (
            <SortableBlock
              block={block}
              columnId={column.id}
              key={block.id}
              pageId={pageId}
              rowId={rowId}
              selected={selectedNodeId === block.id}
              onDelete={() => onDeleteBlock(block.id)}
              onSelect={onSelect}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}

interface SortableRowProps {
  pageId: string;
  row: LayoutRow;
  selected: boolean;
  selectedNodeId: string | null;
  onSelect: (selection: LayoutSelection) => void;
  onDelete: () => void;
  onAddColumn: () => void;
  onDeleteColumn: (columnId: string) => void;
  onDeleteBlock: (columnId: string, blockId: string) => void;
}

function SortableRow({
  pageId,
  row,
  selected,
  selectedNodeId,
  onSelect,
  onDelete,
  onAddColumn,
  onDeleteColumn,
  onDeleteBlock,
}: SortableRowProps) {
  const {
    attributes,
    isDragging,
    isOver,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: row.id,
    data: { kind: "row", pageId, rowId: row.id },
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <section
      className={[
        "layout-editor-row",
        selected ? "is-selected" : "",
        isOver ? "is-drop-target" : "",
      ].filter(Boolean).join(" ")}
      data-layout-spacing={row.spacing ?? "medium"}
      ref={setNodeRef}
      style={style}
    >
      <div className="layout-editor-node-toolbar">
        <button
          aria-label={`Déplacer ${getRowLabel(row)}`}
          className="layout-editor-drag-handle"
          type="button"
          {...attributes}
          {...listeners}
        >
          ::
        </button>
        <button
          className="layout-editor-node-select"
          type="button"
          onClick={() => onSelect({ kind: "row", pageId, rowId: row.id })}
        >
          {getRowLabel(row)}
        </button>
        <button className="layout-editor-add-inline" type="button" onClick={onAddColumn}>
          + Colonne
        </button>
        <button className="layout-editor-delete" type="button" onClick={onDelete}>
          Supprimer
        </button>
      </div>
      <SortableContext
        items={row.columns.map((column) => column.id)}
        strategy={rectSortingStrategy}
      >
        <div className="layout-grid-row" data-layout-spacing={row.spacing ?? "medium"}>
          {row.columns.map((column) => (
            <SortableColumn
              canDelete={row.columns.length > 1}
              column={column}
              key={column.id}
              pageId={pageId}
              rowId={row.id}
              selected={selectedNodeId === column.id}
              selectedNodeId={selectedNodeId}
              onDelete={() => onDeleteColumn(column.id)}
              onDeleteBlock={(blockId) => onDeleteBlock(column.id, blockId)}
              onSelect={onSelect}
            />
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

export function EditorCanvas({
  page,
  selected,
  device,
  onSelect,
  onDeleteRow,
  onAddColumn,
  onDeleteColumn,
  onDeleteBlock,
  onMove,
  onTransformStart,
  onTransformPreview,
  onTransformCommit,
  onTransformCancel,
}: EditorCanvasProps) {
  const [activeDrag, setActiveDrag] = useState<EditorDndData | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const selectedNodeId = getSelectionId(selected);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDrag(isEditorDndData(event.active.data.current) ? event.active.data.current : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null);
    if (event.over === null) {
      return;
    }
    const active = event.active.data.current;
    const target = event.over.data.current;
    if (
      isEditorDndData(active) &&
      isEditorDndData(target) &&
      active.pageId === page.id &&
      target.pageId === page.id
    ) {
      onMove(active, target);
    }
  };

  return (
    <section className="layout-editor-stage" aria-label="Zone de conception">
      <div className="layout-editor-stage-header">
        <h2>{page.title}</h2>
        <span>Aperçu {device}</span>
      </div>
      {page.layoutMode === "free" ? (
        <FreeLayoutCanvas
          page={page}
          selected={selected ?? { kind: "page", pageId: page.id }}
          device={device}
          onSelect={onSelect}
          onTransformStart={onTransformStart}
          onTransformPreview={onTransformPreview}
          onTransformCommit={onTransformCommit}
          onTransformCancel={onTransformCancel}
        />
      ) : (
        <DndContext
          collisionDetection={closestCenter}
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveDrag(null)}
        >
          <div
            className={`layout-editor-page layout-page layout-page--${device}`}
            data-testid="layout-editor-canvas"
          >
            {page.rows.length === 0 && (
              <p className="layout-editor-empty">
                Cette page est vide. Ajoutez une ligne depuis la bibliothèque.
              </p>
            )}
            <SortableContext
              items={page.rows.map((row) => row.id)}
              strategy={verticalListSortingStrategy}
            >
              {page.rows.map((row) => (
                <SortableRow
                  key={row.id}
                  pageId={page.id}
                  row={row}
                  selectedNodeId={selectedNodeId}
                  selected={selectedNodeId === row.id}
                  onAddColumn={() => onAddColumn(row.id)}
                  onDelete={() => onDeleteRow(row.id)}
                  onDeleteBlock={(columnId, blockId) =>
                    onDeleteBlock(row.id, columnId, blockId)
                  }
                  onDeleteColumn={(columnId) => onDeleteColumn(row.id, columnId)}
                  onSelect={onSelect}
                />
              ))}
            </SortableContext>
          </div>
          <DragOverlay>
            {activeDrag !== null && (
              <div className="layout-editor-drag-overlay">
                {getDragLabel(activeDrag)}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </section>
  );
}
