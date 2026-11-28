import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import {
  defaultCanvasInteractionPreferences,
  updateCanvasGesture,
  type AlignmentGuide,
  type CanvasGesture,
  type CanvasRect,
  type ResizeEdges,
} from "../engine/index.ts";
import { LayoutIconView, LayoutBlockContent } from "../components/registry.tsx";
import type { CanvasBreakpoint } from "../engine/types.ts";
import type { LayoutBlock, LayoutPage } from "../schema/types.ts";
import type { LayoutSelection } from "./layoutOperations.ts";
import {
  getFreeCanvasHeight,
  getFreeCanvasWidth,
  getLayoutSelectionId,
  getNearestFreeLayoutDistance,
  listFreeLayoutItems,
  type FreeLayoutItem,
} from "./freeLayout.ts";

interface FreeLayoutCanvasProps {
  page: LayoutPage;
  selected: LayoutSelection;
  device: CanvasBreakpoint;
  onSelect: (selection: LayoutSelection) => void;
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

type GestureMode = "move" | "resize";

interface ActiveGesture
  extends CanvasGesture<Exclude<LayoutSelection, { kind: "page" }>> {
  pointerId: number;
  captureTarget: HTMLDivElement | HTMLButtonElement;
  currentRect: CanvasRect;
  targetItems: FreeLayoutItem[];
  guides: AlignmentGuide[];
  moved: boolean;
}

const resizeHandles: Array<{
  name: string;
  edges: ResizeEdges;
}> = [
  { name: "top-left", edges: { top: true, left: true } },
  { name: "top", edges: { top: true } },
  { name: "top-right", edges: { top: true, right: true } },
  { name: "right", edges: { right: true } },
  { name: "bottom-right", edges: { bottom: true, right: true } },
  { name: "bottom", edges: { bottom: true } },
  { name: "bottom-left", edges: { bottom: true, left: true } },
  { name: "left", edges: { left: true } },
];

function sameRect(first: CanvasRect, second: CanvasRect): boolean {
  return (
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height
  );
}

function getUniqueGuides(guides: AlignmentGuide[]): AlignmentGuide[] {
  const seen = new Set<string>();
  return guides.filter((guide) => {
    const key = `${guide.axis}:${guide.position}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getSelectedBlock(
  page: LayoutPage,
  selection: LayoutSelection,
): LayoutBlock | undefined {
  if (selection.kind !== "block" && selection.kind !== "icon") {
    return undefined;
  }
  return page.rows
    .find((row) => row.id === selection.rowId)
    ?.columns.find((column) => column.id === selection.columnId)
    ?.blocks.find((block) => block.id === selection.blockId);
}

export function FreeLayoutCanvas({
  page,
  selected,
  device,
  onSelect,
  onTransformStart,
  onTransformPreview,
  onTransformCommit,
  onTransformCancel,
}: FreeLayoutCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<ActiveGesture | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(
    defaultCanvasInteractionPreferences.snapEnabled,
  );
  const [activeRect, setActiveRect] = useState<CanvasRect | null>(null);
  const [activeGuides, setActiveGuides] = useState<AlignmentGuide[]>([]);
  const [activeDistance, setActiveDistance] = useState<{
    label: string;
    xGap: number;
    yGap: number;
  } | null>(null);

  const items = useMemo(
    () => listFreeLayoutItems(page, device),
    [device, page],
  );
  const itemLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      const key = JSON.stringify([item.kind, item.label]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const occurrences = new Map<string, number>();
    const labels = new Map<string, { option: string; accessible: string }>();
    for (const item of items) {
      const key = JSON.stringify([item.kind, item.label]);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const suffix =
        (counts.get(key) ?? 0) > 1 ? ` ${occurrence + 1}` : "";
      labels.set(item.id, {
        option: `${item.label} · ${item.kind}${suffix}`,
        accessible: `${item.kind} ${item.label}${suffix}`,
      });
    }
    return labels;
  }, [items]);
  const selectedId = getLayoutSelectionId(selected);
  const selectedItem = items.find((item) => item.id === selectedId);
  const width = getFreeCanvasWidth(device);
  const height = getFreeCanvasHeight(page, device);
  const canvasBounds = {
    x: 0,
    y: 0,
    width: width - 34,
    height: height,
  };

  const beginGesture = (
    event: PointerEvent<HTMLDivElement | HTMLButtonElement>,
    item: FreeLayoutItem,
    mode: GestureMode,
    edges: ResizeEdges = {},
  ) => {
    if (
      event.button !== 0 ||
      item.selection.kind === "page" ||
      gestureRef.current !== null
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(item.selection);
    onTransformStart();
    gestureRef.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      itemId: item.id,
      payload: item.selection,
      mode,
      startPoint: { x: event.clientX, y: event.clientY },
      startRect: item.rect,
      currentRect: item.rect,
      edges,
      targets: items
        .filter((target) => target.id !== item.id)
        .map((target) => ({ id: target.id, rect: target.rect })),
      targetItems: items.filter((target) => target.id !== item.id),
      guides: [],
      moved: false,
    };
    setActiveRect(item.rect);
    setActiveGuides([]);
    setActiveDistance(null);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) {
      return;
    }
    if (
      Math.hypot(
        event.clientX - gesture.startPoint.x,
        event.clientY - gesture.startPoint.y,
      ) < 3
    ) {
      return;
    }

    const updated = updateCanvasGesture(
      gesture,
      { x: event.clientX, y: event.clientY },
      {
        enabled: snapEnabled,
        tolerance: defaultCanvasInteractionPreferences.snapTolerance,
        canvas: canvasBounds,
        preserveAspectRatio: event.shiftKey && gesture.mode === "resize",
      },
    );
    const rect = updated.rect;
    gesture.currentRect = rect;
    gesture.guides = getUniqueGuides(updated.guides);
    gesture.moved = !sameRect(rect, gesture.startRect);
    setActiveRect(rect);
    setActiveGuides(gesture.guides);
    const nearest = getNearestFreeLayoutDistance(
      rect,
      gesture.targetItems,
      getLayoutSelectionId(gesture.payload),
    );
    const targetLabel =
      gesture.targetItems.find((target) => target.id === nearest?.id)?.label ?? "";
    setActiveDistance(
      nearest === null
        ? null
        : {
            label: targetLabel,
            xGap: nearest.xGap,
            yGap: nearest.yGap,
          },
    );
    onTransformPreview(gesture.payload, rect);
  };

  const finishGesture = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) {
      return;
    }
    gestureRef.current = null;
    if (gesture.moved && !sameRect(gesture.currentRect, gesture.startRect)) {
      onTransformCommit(gesture.payload, gesture.currentRect);
    } else {
      onTransformCancel();
    }
    setActiveRect(null);
    setActiveGuides([]);
    setActiveDistance(null);
    if (gesture.captureTarget.hasPointerCapture(event.pointerId)) {
      gesture.captureTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelGesture = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) {
      return;
    }
    gestureRef.current = null;
    onTransformCancel();
    setActiveRect(null);
    setActiveGuides([]);
    setActiveDistance(null);
  };

  return (
    <>
      <div className="layout-editor-free-controls">
        <label>
          Sélectionner un objet
          <select
            aria-label="Sélectionner un objet"
            value={selectedItem?.id ?? ""}
            onChange={(event) => {
              const item = items.find((candidate) => candidate.id === event.target.value);
              if (item !== undefined) {
                onSelect(item.selection);
              }
            }}
          >
            <option value="">Choisir…</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {itemLabels.get(item.id)?.option ?? `${item.label} · ${item.kind}`}
              </option>
            ))}
          </select>
        </label>
        <label className="layout-editor-snap-toggle">
          <input
            type="checkbox"
            checked={snapEnabled}
            onChange={(event) => setSnapEnabled(event.target.checked)}
          />
          Magnétisme
        </label>
        <span className="layout-editor-free-hint">
          Glisser pour déplacer; poignées pour redimensionner. Maj conserve les proportions. Les écarts négatifs indiquent un chevauchement.
        </span>
      </div>
      <div
        className={`layout-editor-page layout-page layout-page--${device} layout-page--free`}
        data-testid="layout-editor-canvas"
        ref={canvasRef}
        style={
          {
            width: `${width}px`,
            minHeight: `${height}px`,
          }
        }
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            onSelect({ kind: "page", pageId: page.id });
          }
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={cancelGesture}
      >
        {items.map((item) => {
          const isSelected = selectedId === item.id;
          const rect =
            activeRect !== null && isSelected ? activeRect : item.rect;
          const style: CSSProperties = {
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            zIndex: item.zIndex,
          };
          const block = getSelectedBlock(page, item.selection);
          const detachedIcon =
            item.selection.kind === "icon" && block?.type === "button"
              ? block.detachedIcon
              : undefined;

          return (
            <div
              aria-label={
                itemLabels.get(item.id)?.accessible ??
                `${item.kind} ${item.label}`
              }
              aria-pressed={isSelected}
              className={[
                "layout-editor-free-item",
                `layout-editor-free-item--${item.kind}`,
                isSelected ? "is-selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-layout-node-id={item.id}
              data-layout-node-kind={item.kind}
              data-testid={`free-item-${item.id}`}
              key={item.id}
              role="button"
              style={style}
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(item.selection);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(item.selection);
                }
              }}
              onPointerDown={(event) => beginGesture(event, item, "move")}
            >
              {item.kind === "block" && block !== undefined && (
                <div className="layout-editor-free-content">
                  <LayoutBlockContent
                    block={block}
                    detachedIconRendering="separate"
                    editorMode
                  />
                </div>
              )}
              {item.kind === "icon" &&
                detachedIcon !== undefined &&
                <LayoutIconView iconId={detachedIcon.iconId} />}
              {(item.kind === "row" || item.kind === "column") &&
                (
                  <span className="layout-editor-free-item-label">
                    {item.kind === "row" ? "Ligne" : "Colonne"} · {item.label}
                  </span>
                )}
            </div>
          );
        })}
        {selectedItem !== undefined && selected.kind !== "page" && (
          <div
            className="layout-editor-resize-overlay"
            role="group"
            aria-label={`Manipuler ${
              itemLabels.get(selectedItem.id)?.accessible ??
              `${selectedItem.kind} ${selectedItem.label}`
            }`}
            style={{
              left: `${(activeRect ?? selectedItem.rect).x}px`,
              top: `${(activeRect ?? selectedItem.rect).y}px`,
              width: `${(activeRect ?? selectedItem.rect).width}px`,
              height: `${(activeRect ?? selectedItem.rect).height}px`,
            }}
            onPointerDown={(event) =>
              beginGesture(event, selectedItem, "move")
            }
          >
            {resizeHandles.map((handle) => (
              <button
                aria-label={`Redimensionner ${
                  itemLabels.get(selectedItem.id)?.accessible ??
                  `${selectedItem.kind} ${selectedItem.label}`
                } ${handle.name}`}
                className={`layout-editor-resize-handle layout-editor-resize-handle--${handle.name}`}
                key={handle.name}
                type="button"
                onPointerDown={(event) =>
                  beginGesture(event, selectedItem, "resize", handle.edges)
                }
                onClick={(event) => event.stopPropagation()}
              />
            ))}
          </div>
        )}
        <div className="layout-editor-free-guides" aria-hidden="true">
          {activeGuides.map((guide) => (
            <div
              className={`layout-editor-free-guide layout-editor-free-guide--${guide.axis}`}
              key={`${guide.axis}:${guide.position}`}
              style={
                guide.axis === "x"
                  ? { left: `${guide.position}px` }
                  : { top: `${guide.position}px` }
              }
            />
          ))}
        </div>
        {activeDistance !== null && activeRect !== null && (
          <div
            className="layout-editor-free-distance"
            role="status"
            style={{
              left: `${activeRect.x}px`,
              top: `${activeRect.y + activeRect.height + 4}px`,
            }}
          >
            {activeDistance.label}: ΔX {activeDistance.xGap.toFixed(1)} px · ΔY{" "}
            {activeDistance.yGap.toFixed(1)} px
          </div>
        )}
      </div>
    </>
  );
}
