import { useEffect, useState, type ReactNode } from "react";
import type { CanvasBreakpoint, CanvasRect, LayerDirection } from "../engine/index.ts";
import type {
  LayoutAlignment,
  LayoutBlock,
  LayoutColumn,
  LayoutConfig,
  LayoutIconId,
  LayoutNodeProperties,
  LayoutPage,
  LayoutRow,
  LayoutSpacing,
} from "../schema/types.ts";
import {
  updateBlock,
  updateColumn,
  updatePage,
  updateRow,
  type LayoutSelection,
} from "./layoutOperations.ts";
import { demoActions, isDemoAction } from "./demoActions.ts";
import {
  getLayoutSelectionId,
  listFreeLayoutItems,
  setButtonIcon,
  updateLayoutNodeRect,
} from "./freeLayout.ts";

interface PropertiesPanelProps {
  layout: LayoutConfig;
  selection: LayoutSelection | null;
  device: CanvasBreakpoint;
  onLayoutChange: (layout: LayoutConfig) => void;
  onMoveLayer: (direction: LayerDirection) => void;
  onDelete: () => void;
}

interface FieldProps {
  label: string;
  children: ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <label className="layout-editor-property">
      <span>{label}</span>
      {children}
    </label>
  );
}

function getNodeName(node: LayoutNodeProperties, fallback: string): string {
  return node.name ?? fallback;
}

function updateNodeProperties<T extends LayoutNodeProperties>(
  node: T,
  changes: Partial<LayoutNodeProperties>,
): T {
  return { ...node, ...changes };
}

function updateNodeName<T extends LayoutNodeProperties>(
  node: T,
  name: string,
): T {
  const next = { ...node };
  if (name.length === 0) {
    delete next.name;
  } else {
    next.name = name;
  }
  return next;
}

function isAlignment(value: string): value is LayoutAlignment {
  return value === "left" || value === "center" || value === "right";
}

function isSpacing(value: string): value is LayoutSpacing {
  return (
    value === "none" ||
    value === "small" ||
    value === "medium" ||
    value === "large"
  );
}

function isIconId(value: string): value is LayoutIconId {
  return value === "info" || value === "check" || value === "arrow-right";
}

function getSelectedPage(
  layout: LayoutConfig,
  pageId: string,
) {
  return layout.pages.find((page) => page.id === pageId);
}

function getRow(
  layout: LayoutConfig,
  pageId: string,
  rowId: string,
): LayoutRow | undefined {
  return getSelectedPage(layout, pageId)?.rows.find((row) => row.id === rowId);
}

function getColumn(
  layout: LayoutConfig,
  pageId: string,
  rowId: string,
  columnId: string,
): LayoutColumn | undefined {
  return getRow(layout, pageId, rowId)?.columns.find(
    (column) => column.id === columnId,
  );
}

function AlignmentProperty({
  value,
  onChange,
}: {
  value: LayoutAlignment;
  onChange: (value: LayoutAlignment) => void;
}) {
  return (
    <Field label="Alignement">
      <select
        value={value}
        onChange={(event) => {
          if (isAlignment(event.target.value)) {
            onChange(event.target.value);
          }
        }}
      >
        <option value="left">Gauche</option>
        <option value="center">Centré</option>
        <option value="right">Droite</option>
      </select>
    </Field>
  );
}

function SpacingProperty({
  value,
  onChange,
}: {
  value: LayoutSpacing;
  onChange: (value: LayoutSpacing) => void;
}) {
  return (
    <Field label="Espacement">
      <select
        value={value}
        onChange={(event) => {
          if (isSpacing(event.target.value)) {
            onChange(event.target.value);
          }
        }}
      >
        <option value="none">Aucun</option>
        <option value="small">Petit</option>
        <option value="medium">Moyen</option>
        <option value="large">Grand</option>
      </select>
    </Field>
  );
}

function GeometryNumberField({
  label,
  value,
  onCommit,
  positive = false,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  positive?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Field label={label}>
      <input
        aria-label={label}
        type="number"
        step="any"
        min={positive ? Number.MIN_VALUE : undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const parsed = Number(draft);
          if (
            draft.trim() === "" ||
            !Number.isFinite(parsed) ||
            (positive && parsed <= 0)
          ) {
            setDraft(String(value));
            return;
          }
          if (parsed !== value) {
            onCommit(parsed);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
}

function FreePlacementProperties({
  layout,
  page,
  selection,
  device,
  onLayoutChange,
  onMoveLayer,
}: {
  layout: LayoutConfig;
  page: LayoutPage;
  selection: Exclude<LayoutSelection, { kind: "page" }>;
  device: CanvasBreakpoint;
  onLayoutChange: (layout: LayoutConfig) => void;
  onMoveLayer: (direction: LayerDirection) => void;
}) {
  if (page.layoutMode !== "free") {
    return null;
  }
  const item = listFreeLayoutItems(page, device).find(
    (candidate) =>
      candidate.id === getLayoutSelectionId(selection),
  );
  if (item === undefined) {
    return null;
  }
  const updateRect = (key: keyof CanvasRect, value: number) => {
    onLayoutChange(
      updateLayoutNodeRect(layout, selection, device, {
        ...item.rect,
        [key]: value,
      }),
    );
  };

  return (
    <fieldset className="layout-editor-geometry">
      <legend>Placement libre · {device}</legend>
      <GeometryNumberField
        label="Position X"
        value={item.rect.x}
        onCommit={(value) => updateRect("x", value)}
      />
      <GeometryNumberField
        label="Position Y"
        value={item.rect.y}
        onCommit={(value) => updateRect("y", value)}
      />
      <GeometryNumberField
        label="Largeur"
        value={item.rect.width}
        positive
        onCommit={(value) => updateRect("width", value)}
      />
      <GeometryNumberField
        label="Hauteur"
        value={item.rect.height}
        positive
        onCommit={(value) => updateRect("height", value)}
      />
      <span className="layout-editor-layer-value">
        Profondeur : {item.zIndex}
      </span>
      <div className="layout-editor-layer-controls" aria-label="Ordre de profondeur">
        <button type="button" onClick={() => onMoveLayer("back")}>
          Tout derrière
        </button>
        <button type="button" onClick={() => onMoveLayer("backward")}>
          Reculer
        </button>
        <button type="button" onClick={() => onMoveLayer("forward")}>
          Avancer
        </button>
        <button type="button" onClick={() => onMoveLayer("front")}>
          Tout devant
        </button>
      </div>
    </fieldset>
  );
}

export function PropertiesPanel({
  layout,
  selection,
  device,
  onLayoutChange,
  onMoveLayer,
  onDelete,
}: PropertiesPanelProps) {
  if (selection === null) {
    return (
      <aside className="layout-editor-properties">
        <h2>Propriétés</h2>
        <p>Sélectionnez une page, une ligne, une colonne ou un composant.</p>
      </aside>
    );
  }

  const page = getSelectedPage(layout, selection.pageId);
  if (page === undefined) {
    return (
      <aside className="layout-editor-properties">
        <h2>Propriétés</h2>
        <p>L’élément sélectionné n’existe plus.</p>
      </aside>
    );
  }

  if (selection.kind === "page") {
    return (
      <aside className="layout-editor-properties">
        <h2>Propriétés de la page</h2>
        <Field label="Nom de la page">
          <input
            maxLength={120}
            value={page.title}
            onChange={(event) =>
              onLayoutChange(
                updatePage(layout, page.id, (currentPage) => ({
                  ...currentPage,
                  title: event.target.value || "Page sans titre",
                })),
              )
            }
          />
        </Field>
      </aside>
    );
  }

  const row = getRow(layout, page.id, selection.rowId);
  if (row === undefined) {
    return (
      <aside className="layout-editor-properties">
        <h2>Propriétés</h2>
        <p>L’élément sélectionné n’existe plus.</p>
      </aside>
    );
  }

  if (selection.kind === "row") {
    return (
      <aside className="layout-editor-properties">
        <h2>Propriétés de la ligne</h2>
        <Field label="Nom">
          <input
            maxLength={120}
            value={getNodeName(row, "Ligne")}
            onChange={(event) =>
              onLayoutChange(
                updateRow(layout, page.id, row.id, (currentRow) =>
                  updateNodeName(currentRow, event.target.value),
                ),
              )
            }
          />
        </Field>
        <SpacingProperty
          value={row.spacing ?? "medium"}
          onChange={(spacing) =>
            onLayoutChange(
              updateRow(layout, page.id, row.id, (currentRow) => ({
                ...currentRow,
                spacing,
              })),
            )
          }
        />
        <FreePlacementProperties
          device={device}
          layout={layout}
          page={page}
          selection={selection}
          onLayoutChange={onLayoutChange}
          onMoveLayer={onMoveLayer}
        />
        <button className="layout-editor-danger" type="button" onClick={onDelete}>
          Supprimer cette ligne
        </button>
      </aside>
    );
  }

  const column = getColumn(layout, page.id, row.id, selection.columnId);
  if (column === undefined) {
    return (
      <aside className="layout-editor-properties">
        <h2>Propriétés</h2>
        <p>L’élément sélectionné n’existe plus.</p>
      </aside>
    );
  }

  if (selection.kind === "column") {
    const updateColumnValue = (update: (current: LayoutColumn) => LayoutColumn) =>
      onLayoutChange(updateColumn(layout, page.id, row.id, column.id, update));
    const setSpan = (key: "mobile" | "tablet" | "desktop", value: number) => {
      if (!Number.isInteger(value) || value < 1 || value > 12) {
        return;
      }
      updateColumnValue((current) => ({
        ...current,
        span: {
          mobile: current.span?.mobile ?? 12,
          tablet: current.span?.tablet ?? 12,
          desktop: current.span?.desktop ?? 12,
          [key]: value,
        },
      }));
    };

    return (
      <aside className="layout-editor-properties">
        <h2>Propriétés de la colonne</h2>
        <Field label="Nom">
          <input
            maxLength={120}
            value={getNodeName(column, "Colonne")}
            onChange={(event) =>
              updateColumnValue((current) =>
                updateNodeName(current, event.target.value),
              )
            }
          />
        </Field>
        <AlignmentProperty
          value={column.alignment ?? "left"}
          onChange={(alignment) =>
            updateColumnValue((current) => ({ ...current, alignment }))
          }
        />
        <SpacingProperty
          value={column.spacing ?? "none"}
          onChange={(spacing) =>
            updateColumnValue((current) => ({ ...current, spacing }))
          }
        />
        {page.layoutMode === "flow" && (
          <fieldset className="layout-editor-spans">
            <legend>Largeur de la grille (sur 12)</legend>
            {(["mobile", "tablet", "desktop"] as const).map((device) => (
              <Field label={device} key={device}>
                <input
                  type="number"
                  min={1}
                  max={12}
                  step={1}
                  value={column.span?.[device] ?? 12}
                  onChange={(event) =>
                    setSpan(device, Number(event.target.value))
                  }
                />
              </Field>
            ))}
          </fieldset>
        )}
        <FreePlacementProperties
          device={device}
          layout={layout}
          page={page}
          selection={selection}
          onLayoutChange={onLayoutChange}
          onMoveLayer={onMoveLayer}
        />
        <button
          className="layout-editor-danger"
          type="button"
          disabled={row.columns.length === 1}
          onClick={onDelete}
        >
          Supprimer cette colonne
        </button>
      </aside>
    );
  }

  const block = column.blocks.find(
    (candidate) => candidate.id === selection.blockId,
  );
  if (block === undefined) {
    return (
      <aside className="layout-editor-properties">
        <h2>Propriétés</h2>
        <p>L’élément sélectionné n’existe plus.</p>
      </aside>
    );
  }

  if (selection.kind === "icon") {
    if (block.type !== "button" || block.detachedIcon?.id !== selection.iconObjectId) {
      return (
        <aside className="layout-editor-properties">
          <h2>Propriétés</h2>
          <p>L’icône sélectionnée n’existe plus.</p>
        </aside>
      );
    }
    return (
      <aside className="layout-editor-properties">
        <h2>Propriétés de l’icône</h2>
        <Field label="Icône">
          <select
            value={block.detachedIcon.iconId}
            onChange={(event) => {
              if (isIconId(event.target.value)) {
                onLayoutChange(
                  setButtonIcon(
                    layout,
                    page,
                    row.id,
                    column.id,
                    block.id,
                    event.target.value,
                  ),
                );
              }
            }}
          >
            <option value="info">Information</option>
            <option value="check">Validation</option>
            <option value="arrow-right">Flèche droite</option>
          </select>
        </Field>
        <FreePlacementProperties
          device={device}
          layout={layout}
          page={page}
          selection={selection}
          onLayoutChange={onLayoutChange}
          onMoveLayer={onMoveLayer}
        />
        <button className="layout-editor-danger" type="button" onClick={onDelete}>
          Supprimer cette icône
        </button>
      </aside>
    );
  }

  const editBlock = (update: (current: LayoutBlock) => LayoutBlock) =>
    onLayoutChange(
      updateBlock(layout, page.id, row.id, column.id, block.id, update),
    );
  const commonBlockProperties = (
    <>
      <Field label="Nom">
        <input
          maxLength={120}
          value={getNodeName(block, block.type)}
          onChange={(event) =>
            editBlock((current) =>
              updateNodeName(current, event.target.value),
            )
          }
        />
      </Field>
      <AlignmentProperty
        value={block.alignment ?? "left"}
        onChange={(alignment) =>
          editBlock((current) =>
            updateNodeProperties(current, { alignment }),
          )
        }
      />
      <SpacingProperty
        value={block.spacing ?? "medium"}
        onChange={(spacing) =>
          editBlock((current) => updateNodeProperties(current, { spacing }))
        }
      />
      <FreePlacementProperties
        device={device}
        layout={layout}
        page={page}
        selection={selection}
        onLayoutChange={onLayoutChange}
        onMoveLayer={onMoveLayer}
      />
    </>
  );

  return (
    <aside className="layout-editor-properties">
      <h2>Propriétés du composant</h2>
      {commonBlockProperties}
      {block.type === "heading" && (
        <>
          <Field label="Texte du titre">
            <input
              maxLength={200}
              value={block.text}
              onChange={(event) =>
                editBlock((current) =>
                  current.type === "heading"
                    ? { ...current, text: event.target.value || "Titre" }
                    : current,
                )
              }
            />
          </Field>
          <Field label="Niveau">
            <select
              value={block.level}
              onChange={(event) =>
                {
                  const level = Number(event.target.value);
                  if (level === 1 || level === 2 || level === 3) {
                    editBlock((current) =>
                      current.type === "heading"
                        ? { ...current, level }
                        : current,
                    );
                  }
                }
              }
            >
              <option value={1}>Titre 1</option>
              <option value={2}>Titre 2</option>
              <option value={3}>Titre 3</option>
            </select>
          </Field>
        </>
      )}
      {block.type === "text" && (
        <>
          <Field label="Contenu">
            <textarea
              maxLength={2000}
              rows={5}
              value={block.text}
              onChange={(event) =>
                editBlock((current) =>
                  current.type === "text"
                    ? { ...current, text: event.target.value || "Texte" }
                    : current,
                )
              }
            />
          </Field>
          <Field label="Style de texte">
            <select
              value={block.tone}
              onChange={(event) =>
                {
                  const tone = event.target.value;
                  if (tone === "default" || tone === "muted" || tone === "accent") {
                    editBlock((current) =>
                      current.type === "text" ? { ...current, tone } : current,
                    );
                  }
                }
              }
            >
              <option value="default">Standard</option>
              <option value="muted">Atténué</option>
              <option value="accent">Accent</option>
            </select>
          </Field>
        </>
      )}
      {block.type === "button" && (
        <>
          <Field label="Libellé">
            <input
              maxLength={80}
              value={block.label}
              onChange={(event) =>
                editBlock((current) =>
                  current.type === "button"
                    ? { ...current, label: event.target.value || "Bouton" }
                    : current,
                )
              }
            />
          </Field>
          <Field label="Action de démonstration autorisée">
            <select
              value={block.actionId}
              onChange={(event) =>
                {
                  if (isDemoAction(event.target.value)) {
                    editBlock((current) =>
                      current.type === "button"
                        ? { ...current, actionId: event.target.value }
                        : current,
                    );
                  }
                }
              }
            >
              {!demoActions.some((action) => action.id === block.actionId) && (
                <option value={block.actionId} disabled>
                  {block.actionId} (non autorisée)
                </option>
              )}
              {demoActions.map((action) => (
                <option key={action.id} value={action.id}>
                  {action.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Icône">
            <select
              value={block.iconId ?? block.detachedIcon?.iconId ?? ""}
              onChange={(event) =>
                {
                  const iconId = event.target.value;
                  if (iconId === "" || isIconId(iconId)) {
                    onLayoutChange(
                      setButtonIcon(
                        layout,
                        page,
                        row.id,
                        column.id,
                        block.id,
                        iconId === "" ? null : iconId,
                      ),
                    );
                  }
                }
              }
            >
              <option value="">Aucune</option>
              <option value="info">Information</option>
              <option value="check">Validation</option>
              <option value="arrow-right">Flèche droite</option>
            </select>
          </Field>
          <Field label="Style du bouton">
            <select
              value={block.variant}
              onChange={(event) =>
                {
                  const variant = event.target.value;
                  if (variant === "primary" || variant === "secondary") {
                    editBlock((current) =>
                      current.type === "button"
                        ? { ...current, variant }
                        : current,
                    );
                  }
                }
              }
            >
              <option value="primary">Principal</option>
              <option value="secondary">Secondaire</option>
            </select>
          </Field>
        </>
      )}
      {block.type === "card" && (
        <>
          <Field label="Titre de la carte">
            <input
              maxLength={120}
              value={block.title}
              onChange={(event) =>
                editBlock((current) =>
                  current.type === "card"
                    ? { ...current, title: event.target.value || "Carte" }
                    : current,
                )
              }
            />
          </Field>
          <Field label="Contenu">
            <textarea
              maxLength={2000}
              rows={5}
              value={block.content}
              onChange={(event) =>
                editBlock((current) =>
                  current.type === "card"
                    ? { ...current, content: event.target.value || "Contenu" }
                    : current,
                )
              }
            />
          </Field>
        </>
      )}
      <button className="layout-editor-danger" type="button" onClick={onDelete}>
        Supprimer ce composant
      </button>
    </aside>
  );
}
