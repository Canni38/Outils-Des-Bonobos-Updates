import type {
  LayoutRepository,
  LayoutRevisionMetadata,
  LayoutSource,
} from "./LayoutRepository.ts";
import type { LayoutConfig } from "../schema/types.ts";
import { parseLayoutConfig } from "../schema/validateLayoutConfig.ts";

const RECORD_VERSION = 1;
const STORAGE_PREFIX = "bonobos.layout.repository.v1:";

interface StoredRevision extends LayoutRevisionMetadata {
  layout: LayoutConfig;
}

interface StoredLayoutRecord {
  recordVersion: typeof RECORD_VERSION;
  draft: LayoutConfig | null;
  published: LayoutConfig | null;
  revisions: StoredRevision[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLayoutId(value: string): boolean {
  return /^[a-z][a-z0-9._-]{0,127}$/.test(value);
}

function parseStoredConfig(
  value: unknown,
  layoutId: string,
  fieldName: string,
): LayoutConfig | null {
  if (value === null) {
    return null;
  }

  const layout = parseLayoutConfig(value);
  if (layout.layoutId !== layoutId) {
    throw new Error(`Stored ${fieldName} does not match layout "${layoutId}".`);
  }
  return layout;
}

function parseStoredRecord(value: unknown, layoutId: string): StoredLayoutRecord {
  if (
    !isObject(value) ||
    value.recordVersion !== RECORD_VERSION ||
    !Array.isArray(value.revisions)
  ) {
    throw new Error(`Stored layout record for "${layoutId}" is invalid.`);
  }

  const draft = parseStoredConfig(value.draft, layoutId, "draft");
  const published = parseStoredConfig(value.published, layoutId, "published");
  const revisions: StoredRevision[] = [];
  const revisionIds = new Set<string>();

  value.revisions.forEach((revision, index) => {
    if (
      !isObject(revision) ||
      typeof revision.revisionId !== "string" ||
      revision.revisionId.length === 0 ||
      typeof revision.createdAt !== "string" ||
      Number.isNaN(Date.parse(revision.createdAt)) ||
      !("layout" in revision)
    ) {
      throw new Error(
        `Stored revision ${index} for layout "${layoutId}" is invalid.`,
      );
    }

    if (revisionIds.has(revision.revisionId)) {
      throw new Error(
        `Stored revision id "${revision.revisionId}" is duplicated.`,
      );
    }
    revisionIds.add(revision.revisionId);

    const revisionLayout = parseStoredConfig(
      revision.layout,
      layoutId,
      `revision ${revision.revisionId}`,
    );
    if (revisionLayout === null) {
      throw new Error(
        `Stored revision "${revision.revisionId}" has no layout.`,
      );
    }

    revisions.push({
      revisionId: revision.revisionId,
      createdAt: revision.createdAt,
      layout: revisionLayout,
    });
  });

  return {
    recordVersion: RECORD_VERSION,
    draft,
    published,
    revisions,
  };
}

function createEmptyRecord(): StoredLayoutRecord {
  return {
    recordVersion: RECORD_VERSION,
    draft: null,
    published: null,
    revisions: [],
  };
}

export class LocalStorageLayoutRepository implements LayoutRepository {
  private readonly storage: Storage;

  constructor(storage: Storage = window.localStorage) {
    this.storage = storage;
  }

  async loadDraft(layoutId: string): Promise<LayoutConfig | null> {
    return this.readRecord(layoutId).draft;
  }

  async loadPublished(layoutId: string): Promise<LayoutConfig | null> {
    return this.readRecord(layoutId).published;
  }

  async saveDraft(layout: LayoutConfig): Promise<void> {
    const validatedLayout = parseLayoutConfig(layout);
    const record = this.readRecord(validatedLayout.layoutId);
    record.draft = validatedLayout;
    this.writeRecord(validatedLayout.layoutId, record);
  }

  async publishDraft(layoutId: string): Promise<void> {
    const record = this.readRecord(layoutId);
    if (record.draft === null) {
      throw new Error(`No draft exists for layout "${layoutId}".`);
    }

    if (
      record.published !== null &&
      JSON.stringify(record.draft) === JSON.stringify(record.published)
    ) {
      return;
    }

    record.published = record.draft;
    record.revisions.push({
      revisionId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      layout: record.draft,
    });
    this.writeRecord(layoutId, record);
  }

  async listRevisions(layoutId: string): Promise<LayoutRevisionMetadata[]> {
    return this.readRecord(layoutId)
      .revisions.slice()
      .reverse()
      .map(({ revisionId, createdAt }) => ({ revisionId, createdAt }));
  }

  async restoreRevision(
    layoutId: string,
    revisionId: string,
  ): Promise<void> {
    const record = this.readRecord(layoutId);
    const revision = record.revisions.find(
      (candidate) => candidate.revisionId === revisionId,
    );
    if (revision === undefined) {
      throw new Error(
        `Revision "${revisionId}" does not exist for layout "${layoutId}".`,
      );
    }

    record.draft = revision.layout;
    this.writeRecord(layoutId, record);
  }

  async exportLayout(
    layoutId: string,
    source: LayoutSource,
  ): Promise<string | null> {
    const record = this.readRecord(layoutId);
    const layout = source === "draft" ? record.draft : record.published;
    return layout === null ? null : JSON.stringify(layout, null, 2);
  }

  async importDraft(json: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("The layout backup is not valid JSON.");
      }
      throw error;
    }

    await this.saveDraft(parseLayoutConfig(value));
  }

  private readRecord(layoutId: string): StoredLayoutRecord {
    this.assertLayoutId(layoutId);
    const raw = this.storage.getItem(this.storageKey(layoutId));
    if (raw === null) {
      return createEmptyRecord();
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Stored layout record for "${layoutId}" is not valid JSON.`);
      }
      throw error;
    }
    return parseStoredRecord(value, layoutId);
  }

  private writeRecord(layoutId: string, record: StoredLayoutRecord): void {
    this.assertLayoutId(layoutId);
    this.storage.setItem(this.storageKey(layoutId), JSON.stringify(record));
  }

  private storageKey(layoutId: string): string {
    return `${STORAGE_PREFIX}${encodeURIComponent(layoutId)}`;
  }

  private assertLayoutId(layoutId: string): void {
    if (!isLayoutId(layoutId)) {
      throw new Error(`Layout id "${layoutId}" is invalid.`);
    }
  }
}
