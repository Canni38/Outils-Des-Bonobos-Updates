import type { CanvasItem } from "./types.ts";

export type LayerDirection = "forward" | "backward" | "front" | "back";

export function sortCanvasItemsByLayer<TPayload>(
  items: readonly CanvasItem<TPayload>[],
): CanvasItem<TPayload>[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        left.item.zIndex - right.item.zIndex || left.index - right.index,
    )
    .map(({ item }) => item);
}

export function moveCanvasItemLayer<TPayload>(
  items: readonly CanvasItem<TPayload>[],
  itemId: string,
  direction: LayerDirection,
): CanvasItem<TPayload>[] {
  const ordered = sortCanvasItemsByLayer(items);
  const currentIndex = ordered.findIndex((item) => item.id === itemId);
  if (currentIndex < 0) {
    throw new Error(`Canvas item "${itemId}" was not found.`);
  }

  const targetIndex =
    direction === "front"
      ? ordered.length - 1
      : direction === "back"
        ? 0
        : direction === "forward"
          ? Math.min(ordered.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1);
  if (targetIndex === currentIndex) {
    return ordered;
  }

  const [item] = ordered.splice(currentIndex, 1);
  ordered.splice(targetIndex, 0, item);
  return ordered.map((layeredItem, zIndex) => ({
    ...layeredItem,
    zIndex,
  }));
}
