import type { LayoutConfig } from "../schema/types";
import type { LayoutRepository } from "./LayoutRepository";
import { LocalStorageLayoutRepository } from "./LocalStorageLayoutRepository";

export class SyncingLayoutRepository implements LayoutRepository {
  private api: LayoutRepository;
  private local: LocalStorageLayoutRepository;
  public syncStatus: "synced" | "offline" | "syncing" | "conflict" | "error" = "synced";
  public conflictLocal: LayoutConfig | null = null;
  public conflictServer: LayoutConfig | null = null;

  async resolveConflict(keep: "local" | "server") {
    if (keep === "local" && this.conflictLocal) {
      await this.api.saveDraft(this.conflictLocal);
      await this.local.saveDraft(this.conflictLocal);
    } else if (keep === "server" && this.conflictServer) {
      await this.local.saveDraft(this.conflictServer);
    }
    this.conflictLocal = null;
    this.conflictServer = null;
    this.syncStatus = "synced";
  }

  constructor(api: LayoutRepository) {
    this.api = api;
    this.local = new LocalStorageLayoutRepository();
  }

  async loadDraft(pageKey: string) {
    try {
      const remote = await this.api.loadDraft(pageKey);
      if (remote) {
        await this.local.saveDraft(remote);
        this.syncStatus = "synced";
        return remote;
      }
    } catch {
      this.syncStatus = "offline";
    }
    return this.local.loadDraft(pageKey);
  }

  async loadPublished(pageKey: string) {
    return this.loadDraft(pageKey);
  }

  async saveDraft(layout: LayoutConfig) {
    await this.local.saveDraft(layout);
    try {
      this.syncStatus = "syncing";
      await this.api.saveDraft(layout);
      this.syncStatus = "synced";
      this.conflictLocal = null;
      this.conflictServer = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("409")) {
        this.syncStatus = "conflict";
        this.conflictLocal = layout;
      } else {
        this.syncStatus = "offline";
      }
    }
  }

  async publishDraft(pageKey: string) {
    try {
      await this.api.publishDraft(pageKey);
      this.syncStatus = "synced";
    } catch {
      this.syncStatus = "offline";
      throw new Error("publish_failed_offline");
    }
  }

  async listRevisions(pageKey: string) {
    try {
      const r = await this.api.listRevisions(pageKey);
      this.syncStatus = "synced";
      return r;
    } catch {
      this.syncStatus = "offline";
      return this.local.listRevisions(pageKey);
    }
  }

  async restoreRevision(pageKey: string, revisionId: string) {
    try {
      await this.api.restoreRevision(pageKey, revisionId);
      this.syncStatus = "synced";
    } catch {
      this.syncStatus = "offline";
      await this.local.restoreRevision(pageKey, revisionId);
    }
  }

  async exportLayout(pageKey: string, source: "draft" | "published") {
    return this.local.exportLayout(pageKey, source);
  }

  async importDraft(json: string) {
    await this.local.importDraft(json);
  }
}
