import type { SqlExecutor, TransactionalSqlExecutor } from "./contracts.js";
import type { LayoutConfig } from "./layoutTypes.js";

export interface LayoutPageRecord {
  id: string;
  projectId: string;
  applicationId: string;
  pageKey: string;
  title: string;
  schemaVersion: number;
  layout: LayoutConfig;
  status: "DRAFT" | "PUBLISHED";
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LayoutRevisionRecord {
  id: string;
  pageId: string;
  revisionNumber: number;
  title: string;
  schemaVersion: number;
  layout: LayoutConfig;
  status: "DRAFT" | "PUBLISHED";
  createdBy: string | null;
  createdAt: string;
}

export class LayoutServiceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LayoutServiceError";
  }
}

export async function loadLayoutPage(
  database: SqlExecutor,
  projectId: string,
  applicationId: string,
  pageKey: string,
): Promise<LayoutPageRecord | null> {
  const result = await database.query<{
    id: string;
    project_id: string;
    application_id: string;
    page_key: string;
    title: string;
    schema_version: number;
    layout: LayoutConfig;
    status: "DRAFT" | "PUBLISHED";
    updated_by: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, project_id, application_id, page_key, title, schema_version, layout, status, updated_by, created_at, updated_at
       FROM pages
      WHERE project_id = $1 AND application_id = $2 AND page_key = $3`,
    [projectId, applicationId, pageKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    applicationId: row.application_id,
    pageKey: row.page_key,
    title: row.title,
    schemaVersion: row.schema_version,
    layout: row.layout,
    status: row.status,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function saveDraftLayout(
  database: TransactionalSqlExecutor,
  actorUserId: string,
  projectId: string,
  applicationId: string,
  pageKey: string,
  title: string,
  schemaVersion: number,
  layout: LayoutConfig,
): Promise<LayoutPageRecord> {
  return database.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM pages WHERE project_id = $1 AND application_id = $2 AND page_key = $3`,
      [projectId, applicationId, pageKey],
    );
    let pageId: string;
    if (existing.rows[0]) {
      pageId = existing.rows[0].id;
      await tx.query(
        `UPDATE pages SET title = $1, schema_version = $2, layout = $3, status = 'DRAFT', updated_by = $4, updated_at = now()
          WHERE id = $5`,
        [title, schemaVersion, JSON.stringify(layout), actorUserId, pageId],
      );
    } else {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO pages (project_id, application_id, page_key, title, schema_version, layout, status, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7) RETURNING id`,
        [projectId, applicationId, pageKey, title, schemaVersion, JSON.stringify(layout), actorUserId],
      );
      pageId = inserted.rows[0].id;
    }
    // revision number
    const revRes = await tx.query<{ n: number }>(
      `SELECT COALESCE(MAX(revision_number),0)+1 AS n FROM page_revisions WHERE page_id = $1`,
      [pageId],
    );
    const revNum = revRes.rows[0].n;
    await tx.query(
      `INSERT INTO page_revisions (page_id, revision_number, title, schema_version, layout, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'DRAFT',$6)`,
      [pageId, revNum, title, schemaVersion, JSON.stringify(layout), actorUserId],
    );
    const page = await loadLayoutPage(tx as unknown as SqlExecutor, projectId, applicationId, pageKey);
    if (!page) throw new LayoutServiceError("page_not_found");
    return page;
  });
}

export async function publishDraftLayout(
  database: TransactionalSqlExecutor,
  actorUserId: string,
  projectId: string,
  applicationId: string,
  pageKey: string,
): Promise<LayoutPageRecord> {
  return database.transaction(async (tx) => {
    const page = await loadLayoutPage(tx as unknown as SqlExecutor, projectId, applicationId, pageKey);
    if (!page) throw new LayoutServiceError("page_not_found");
    await tx.query(
      `UPDATE pages SET status = 'PUBLISHED', updated_by = $1, updated_at = now() WHERE id = $2`,
      [actorUserId, page.id],
    );
    // mark latest revision published
    await tx.query(
      `UPDATE page_revisions SET status = 'PUBLISHED' WHERE page_id = $1 AND revision_number = (SELECT MAX(revision_number) FROM page_revisions WHERE page_id = $1)`,
      [page.id],
    );
    const updated = await loadLayoutPage(tx as unknown as SqlExecutor, projectId, applicationId, pageKey);
    if (!updated) throw new LayoutServiceError("page_not_found");
    return updated;
  });
}

export async function listLayoutRevisions(
  database: SqlExecutor,
  projectId: string,
  applicationId: string,
  pageKey: string,
): Promise<LayoutRevisionRecord[]> {
  const page = await loadLayoutPage(database, projectId, applicationId, pageKey);
  if (!page) return [];
  const result = await database.query<{
    id: string;
    page_id: string;
    revision_number: number;
    title: string;
    schema_version: number;
    layout: LayoutConfig;
    status: "DRAFT" | "PUBLISHED";
    created_by: string | null;
    created_at: string;
  }>(
    `SELECT id, page_id, revision_number, title, schema_version, layout, status, created_by, created_at
       FROM page_revisions WHERE page_id = $1 ORDER BY revision_number DESC`,
    [page.id],
  );
  return result.rows.map((r) => ({
    id: r.id,
    pageId: r.page_id,
    revisionNumber: r.revision_number,
    title: r.title,
    schemaVersion: r.schema_version,
    layout: r.layout,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

export async function restoreLayoutRevision(
  database: TransactionalSqlExecutor,
  actorUserId: string,
  projectId: string,
  applicationId: string,
  pageKey: string,
  revisionNumber: number,
): Promise<LayoutPageRecord> {
  return database.transaction(async (tx) => {
    const page = await loadLayoutPage(tx as unknown as SqlExecutor, projectId, applicationId, pageKey);
    if (!page) throw new LayoutServiceError("page_not_found");
    const revRes = await tx.query<{
      title: string;
      schema_version: number;
      layout: LayoutConfig;
      status: "DRAFT" | "PUBLISHED";
    }>(
      `SELECT title, schema_version, layout, status FROM page_revisions WHERE page_id = $1 AND revision_number = $2`,
      [page.id, revisionNumber],
    );
    const rev = revRes.rows[0];
    if (!rev) throw new LayoutServiceError("revision_not_found");
    await tx.query(
      `UPDATE pages SET title = $1, schema_version = $2, layout = $3, status = $4, updated_by = $5, updated_at = now() WHERE id = $6`,
      [rev.title, rev.schema_version, JSON.stringify(rev.layout), rev.status, actorUserId, page.id],
    );
    const updated = await loadLayoutPage(tx as unknown as SqlExecutor, projectId, applicationId, pageKey);
    if (!updated) throw new LayoutServiceError("page_not_found");
    return updated;
  });
}
