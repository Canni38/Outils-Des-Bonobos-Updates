import type { LayoutConfig } from "../schema/types";
import type { LayoutRepository, LayoutRevisionMetadata } from "./LayoutRepository";

const API_BASE = import.meta.env.VITE_BONOBOS_API_URL?.trim() || "http://127.0.0.1:8080";

export class ApiLayoutRepository implements LayoutRepository {
  constructor(private readonly projectId: string, private readonly applicationId: string, private readonly pageKey: string) {}

  private opts(extra: RequestInit = {}) {
    return { credentials: "include" as RequestCredentials, ...extra };
  }

  private url(suffix = "") {
    return `${API_BASE}/v1/layouts/${this.projectId}/${this.applicationId}/${this.pageKey}${suffix}`;
  }

  async loadDraft(_pageKey: string) {
    const res = await fetch(this.url(), this.opts());
    if (res.status === 404) return null;
    const data = await res.json();
    return (data.page?.layout ?? null) as LayoutConfig | null;
  }

  async loadPublished(_pageKey: string) {
    return this.loadDraft(_pageKey);
  }

  async saveDraft(layout: LayoutConfig) {
    const res = await fetch(this.url(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Draft", schemaVersion: 3, layout }),
      ...this.opts(),
    });
    if (!res.ok) throw new Error(`save_failed_${res.status}`);
  }

  async publishDraft(_pageKey: string) {
    await fetch(this.url("/publish"), { method: "POST", ...this.opts() });
  }

  async listRevisions(_pageKey: string): Promise<LayoutRevisionMetadata[]> {
    const res = await fetch(this.url("/revisions"), this.opts());
    const data = await res.json();
    return (data.revisions ?? []).map((r: any) => ({
      revisionId: r.id,
      createdAt: r.createdAt,
    }));
  }

  async restoreRevision(_pageKey: string, revisionId: string) {
    await fetch(this.url("/restore"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revisionNumber: Number(revisionId) }),
      ...this.opts(),
    });
  }

  async exportLayout(_pageKey: string, _source: "draft" | "published") {
    const l = await this.loadDraft(_pageKey);
    return l ? JSON.stringify(l) : null;
  }

  async importDraft(json: string) {
    try {
      const layout = JSON.parse(json);
      await this.saveDraft(layout);
    } catch {
      // ignore
    }
  }
}
