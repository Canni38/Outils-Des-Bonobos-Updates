import type { LayoutConfig } from "../schema/types.ts";

export type LayoutSource = "draft" | "published";

export interface LayoutRevisionMetadata {
  revisionId: string;
  createdAt: string;
}

export interface LayoutRepository {
  loadDraft(layoutId: string): Promise<LayoutConfig | null>;
  loadPublished(layoutId: string): Promise<LayoutConfig | null>;
  saveDraft(layout: LayoutConfig): Promise<void>;
  publishDraft(layoutId: string): Promise<void>;
  listRevisions(layoutId: string): Promise<LayoutRevisionMetadata[]>;
  restoreRevision(layoutId: string, revisionId: string): Promise<void>;
  exportLayout(layoutId: string, source: LayoutSource): Promise<string | null>;
  importDraft(json: string): Promise<void>;
}
