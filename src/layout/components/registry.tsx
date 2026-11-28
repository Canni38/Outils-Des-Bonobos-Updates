import type { ComponentType } from "react";
import type {
  ButtonBlock,
  CardBlock,
  HeadingBlock,
  LayoutBlock,
  LayoutIconId,
  SeparatorBlock,
  TextBlock,
} from "../schema/types.ts";

export type LayoutActionHandler = (actionId: string) => void;

interface BlockViewProps<T extends LayoutBlock> {
  block: T;
  onAction?: LayoutActionHandler;
  editorMode?: boolean;
  detachedIconRendering?: "inline" | "separate";
}

type LayoutComponentRegistry = {
  heading: ComponentType<BlockViewProps<HeadingBlock>>;
  text: ComponentType<BlockViewProps<TextBlock>>;
  button: ComponentType<BlockViewProps<ButtonBlock>>;
  card: ComponentType<BlockViewProps<CardBlock>>;
  separator: ComponentType<BlockViewProps<SeparatorBlock>>;
};

function getBlockClass(block: LayoutBlock, suffix: string): string {
  return [
    "layout-block",
    `layout-block--${suffix}`,
    `layout-block--align-${block.alignment ?? "left"}`,
    `layout-block--space-${block.spacing ?? "medium"}`,
  ].join(" ");
}

export function LayoutIconView({ iconId }: { iconId: LayoutIconId }) {
  if (iconId === undefined) {
    return null;
  }

  if (iconId === "info") {
    return (
      <svg className="layout-icon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" />
        <path d="M8 7v4M8 5h.01" stroke="currentColor" />
      </svg>
    );
  }

  if (iconId === "check") {
    return (
      <svg className="layout-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m3 8 3.2 3.2L13 4.5" fill="none" stroke="currentColor" />
      </svg>
    );
  }

  return (
    <svg className="layout-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 8h11M8 3l5 5-5 5" fill="none" stroke="currentColor" />
    </svg>
  );
}

function HeadingBlockView({ block }: BlockViewProps<HeadingBlock>) {
  const className = getBlockClass(block, "heading");
  if (block.level === 1) {
    return <h1 className={className}>{block.text}</h1>;
  }
  if (block.level === 2) {
    return <h2 className={className}>{block.text}</h2>;
  }
  return <h3 className={className}>{block.text}</h3>;
}

function TextBlockView({ block }: BlockViewProps<TextBlock>) {
  return (
    <p
      className={`${getBlockClass(block, "text")} layout-block-text--${block.tone}`}
    >
      {block.text}
    </p>
  );
}

function ButtonBlockView({
  block,
  onAction,
  editorMode = false,
  detachedIconRendering = "inline",
}: BlockViewProps<ButtonBlock>) {
  const className = [
    getBlockClass(block, "button"),
    `layout-block-button--${block.variant}`,
  ].join(" ");
  const iconId =
    block.iconId ??
    (detachedIconRendering === "inline"
      ? block.detachedIcon?.iconId
      : undefined);
  const content = (
    <>
      {iconId === undefined && block.detachedIcon !== undefined ? (
        <span className="layout-icon-placeholder" aria-hidden="true" />
      ) : (
        iconId !== undefined && <LayoutIconView iconId={iconId} />
      )}
      <span>{block.label}</span>
    </>
  );

  if (editorMode) {
    return <div className={className}>{content}</div>;
  }

  return (
    <button
      className={className}
      type="button"
      disabled={onAction === undefined}
      onClick={() => onAction?.(block.actionId)}
    >
      {content}
    </button>
  );
}

function CardBlockView({ block }: BlockViewProps<CardBlock>) {
  return (
    <article className={getBlockClass(block, "card")}>
      <h3>{block.title}</h3>
      <p>{block.content}</p>
    </article>
  );
}

function SeparatorBlockView({ block }: BlockViewProps<SeparatorBlock>) {
  return (
    <hr
      className={getBlockClass(block, "separator")}
      aria-label={block.name ?? "Séparateur"}
    />
  );
}

export const layoutComponentRegistry = {
  heading: HeadingBlockView,
  text: TextBlockView,
  button: ButtonBlockView,
  card: CardBlockView,
  separator: SeparatorBlockView,
} satisfies LayoutComponentRegistry;

export interface LayoutBlockContentProps {
  block: LayoutBlock;
  onAction?: LayoutActionHandler;
  editorMode?: boolean;
  detachedIconRendering?: "inline" | "separate";
}

export function LayoutBlockContent({
  block,
  onAction,
  editorMode,
  detachedIconRendering,
}: LayoutBlockContentProps) {
  switch (block.type) {
    case "heading": {
      const Component = layoutComponentRegistry.heading;
      return (
        <Component
          block={block}
          detachedIconRendering={detachedIconRendering}
          onAction={onAction}
        />
      );
    }
    case "text": {
      const Component = layoutComponentRegistry.text;
      return (
        <Component
          block={block}
          detachedIconRendering={detachedIconRendering}
          onAction={onAction}
        />
      );
    }
    case "button": {
      const Component = layoutComponentRegistry.button;
      return (
        <Component
          block={block}
          detachedIconRendering={detachedIconRendering}
          onAction={onAction}
          editorMode={editorMode}
        />
      );
    }
    case "card": {
      const Component = layoutComponentRegistry.card;
      return (
        <Component
          block={block}
          detachedIconRendering={detachedIconRendering}
          onAction={onAction}
        />
      );
    }
    case "separator": {
      const Component = layoutComponentRegistry.separator;
      return (
        <Component
          block={block}
          detachedIconRendering={detachedIconRendering}
          onAction={onAction}
        />
      );
    }
    default:
      return assertNever(block);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported layout block: ${value}`);
}
