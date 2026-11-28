import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutRenderer } from "../LayoutRenderer.tsx";
import { demoHomeLayout } from "../demo/demoHomeLayout.ts";
import {
  commitHistory,
  createHistory,
  redoHistory,
  undoHistory,
  type HistoryState,
} from "../history.ts";
import type { LayoutConfig } from "../schema/types.ts";
import type { LayerDirection } from "../engine/index.ts";
import type { LayoutRepository } from "../storage/LayoutRepository.ts";
import { LocalStorageLayoutRepository } from "../storage/LocalStorageLayoutRepository.ts";
import { SyncingLayoutRepository } from "../storage/SyncingLayoutRepository.ts";
import { ComponentLibrary } from "./ComponentLibrary.tsx";
import {
  EditorCanvas,
  type EditorDndData,
} from "./EditorCanvas.tsx";
import { isDemoAction } from "./demoActions.ts";
import { PropertiesPanel } from "./PropertiesPanel.tsx";
import {
  convertPageToFreeLayout,
  deleteDetachedIcon,
  ensureFreeLayoutGeometry,
  updateLayoutNodeLayer,
  updateLayoutNodeRect,
} from "./freeLayout.ts";
import {
  addBlock,
  addColumn,
  addPage,
  addRow,
  deleteBlock,
  deleteColumn,
  deleteRow,
  moveBlock,
  moveColumn,
  moveRow,
  type LayoutSelection,
  type NewBlockType,
} from "./layoutOperations.ts";
import { validateLayoutConfig } from "../schema/validateLayoutConfig.ts";
import { PAGE_REGISTRY } from "./pageRegistry.ts";
import "./editor.css";

type DevicePreview = "mobile" | "tablet" | "desktop";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDevicePreview(value: string): value is DevicePreview {
  return value === "mobile" || value === "tablet" || value === "desktop";
}

export function LayoutEditor({ repository: injectedRepository, initialLayout }: { repository?: LayoutRepository; initialLayout?: LayoutConfig } = {}) {
  const repository = useMemo(
    () => injectedRepository ?? new LocalStorageLayoutRepository(),
    [injectedRepository],
  );
  const [history, setHistory] = useState<HistoryState<LayoutConfig>>(() =>
    createHistory(initialLayout ?? demoHomeLayout),
  );
  const [selectedPageId, setSelectedPageId] = useState<string>(PAGE_REGISTRY[0].id);
  const [gesturePreview, setGesturePreview] = useState<LayoutConfig | null>(null);
  const gestureBaseRef = useRef<LayoutConfig | null>(null);
  const [selected, setSelected] = useState<LayoutSelection>({
    kind: "page",
    pageId: demoHomeLayout.pages[0].id,
  });
  const [currentPageId, setCurrentPageId] = useState(
    demoHomeLayout.pages[0].id,
  );
  const [device, setDevice] = useState<DevicePreview>("desktop");
  const [isPreview, setIsPreview] = useState(false);
  const [isStorageReady, setIsStorageReady] = useState(false);
  const [saveState, setSaveState] = useState<
    "loading" | "saving" | "saved" | "error"
  >("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<
    Awaited<ReturnType<typeof repository.listRevisions>>
  >([]);
  const [selectedRevisionId, setSelectedRevisionId] = useState("");

  const layout = history.present;
  const displayLayout = gesturePreview ?? layout;
  const currentPage =
    displayLayout.pages.find((page) => page.id === currentPageId) ??
    displayLayout.pages[0];

  const applyHistoryState = useCallback(
    (nextState: HistoryState<LayoutConfig>) => {
      const pageId = nextState.present.pages.some(
        (page) => page.id === currentPageId,
      )
        ? currentPageId
        : nextState.present.pages[0].id;
      setHistory(nextState);
      gestureBaseRef.current = null;
      setGesturePreview(null);
      setCurrentPageId(pageId);
      setSelected({ kind: "page", pageId });
    },
    [currentPageId],
  );
  const handleUndo = useCallback(
    () => applyHistoryState(undoHistory(history)),
    [applyHistoryState, history],
  );
  const handleRedo = useCallback(
    () => applyHistoryState(redoHistory(history)),
    [applyHistoryState, history],
  );

  useEffect(() => {
    let cancelled = false;
    void repository
      .loadDraft(demoHomeLayout.layoutId)
      .then((draft) => {
        if (cancelled) {
          return;
        }
        if (draft !== null) {
          setHistory(createHistory(draft));
          setCurrentPageId(draft.pages[0].id);
          setSelected({ kind: "page", pageId: draft.pages[0].id });
        }
        setIsStorageReady(true);
        setSaveState("saved");
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setErrorMessage(`Impossible de charger le brouillon : ${getErrorMessage(error)}`);
        setSaveState("error");
        setIsStorageReady(true);
      });

    return () => {
      cancelled = true;
    };

  }, [repository]);

  useEffect(() => {
    if (!isStorageReady) {
      return;
    }

    let cancelled = false;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      void repository
        .saveDraft(layout)
        .then(() => {
          if (!cancelled) {
      setSaveState("saved");
      setErrorMessage(null);
      setNoticeMessage("Brouillon enregistré avec succès.");
      setNoticeMessage("Brouillon enregistré avec succès.");
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setSaveState("error");
            setErrorMessage(`Impossible d’enregistrer le brouillon : ${getErrorMessage(error)}`);
          }
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isStorageReady, layout, repository]);

  useEffect(() => {
    if (!isStorageReady) {
      return;
    }
    void repository
      .listRevisions(layout.layoutId)
      .then((nextRevisions) => setRevisions(nextRevisions))
      .catch((error: unknown) =>
        setErrorMessage(`Impossible de lire les révisions : ${getErrorMessage(error)}`),
      );
  }, [isStorageReady, layout.layoutId, repository]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || isPreview || gestureBaseRef.current !== null) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        handleRedo();
      } else if (key === "z") {
        event.preventDefault();
        handleUndo();
      } else if (key === "y") {
        event.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleRedo, handleUndo, isPreview]);

  const commitLayout = useCallback((nextLayout: LayoutConfig) => {
    const result = validateLayoutConfig(nextLayout);
    if (!result.valid) {
      setErrorMessage(
        `Modification refusée : ${result.issues
          .map(({ path, message }) => `${path} ${message}`)
          .join("; ")}`,
      );
      return;
    }
    setHistory((state) => commitHistory(state, result.value));
    setErrorMessage(null);
    setNoticeMessage(null);
  }, []);

  const updatePageIfFree = (nextLayout: LayoutConfig, pageId: string) => {
    const page = nextLayout.pages.find((candidate) => candidate.id === pageId);
    if (page === undefined || page.layoutMode !== "free") {
      return nextLayout;
    }
    const initialized = ensureFreeLayoutGeometry(page);
    return {
      ...nextLayout,
      pages: nextLayout.pages.map((candidate) =>
        candidate.id === pageId ? initialized : candidate,
      ),
    };
  };

  const handleTransformStart = () => {
    gestureBaseRef.current = layout;
    setGesturePreview(layout);
  };

  const handleTransformPreview = (
    selection: Exclude<LayoutSelection, { kind: "page" }>,
    rect: Parameters<typeof updateLayoutNodeRect>[3],
  ) => {
    const base = gestureBaseRef.current;
    if (base === null) {
      return;
    }
    setGesturePreview(updateLayoutNodeRect(base, selection, device, rect));
  };

  const handleTransformCommit = (
    selection: Exclude<LayoutSelection, { kind: "page" }>,
    rect: Parameters<typeof updateLayoutNodeRect>[3],
  ) => {
    const base = gestureBaseRef.current ?? layout;
    gestureBaseRef.current = null;
    setGesturePreview(null);
    commitLayout(updateLayoutNodeRect(base, selection, device, rect));
  };

  const handleTransformCancel = () => {
    gestureBaseRef.current = null;
    setGesturePreview(null);
  };

  const handleMoveLayer = (direction: LayerDirection) => {
    if (selected === null || selected.kind === "page") {
      return;
    }
    try {
      commitLayout(updateLayoutNodeLayer(layout, currentPage, selected, direction));
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const getRowTargetId = () => {
    if (selected !== null && selected.pageId === currentPage.id) {
      if (selected.kind === "row") {
        return selected.rowId;
      }
      if (
        selected.kind === "column" ||
        selected.kind === "block" ||
        selected.kind === "icon"
      ) {
        return selected.rowId;
      }
    }
    return currentPage.rows[0]?.id ?? null;
  };

  const getColumnTarget = () => {
    if (
      selected !== null &&
      selected.pageId === currentPage.id &&
      (selected.kind === "column" ||
        selected.kind === "block" ||
        selected.kind === "icon")
    ) {
      return { rowId: selected.rowId, columnId: selected.columnId };
    }
    const row = currentPage.rows.find((candidate) => candidate.id === getRowTargetId());
    const column = row?.columns[0];
    return column === undefined || row === undefined
      ? null
      : { rowId: row.id, columnId: column.id };
  };

  const handleAddRow = () => {
    try {
      const next = updatePageIfFree(addRow(layout, currentPage.id), currentPage.id);
      const rows = next.pages.find((page) => page.id === currentPage.id)?.rows;
      const addedRow = rows?.[rows.length - 1];
      commitLayout(next);
      if (addedRow !== undefined) {
        setSelected({
          kind: "row",
          pageId: currentPage.id,
          rowId: addedRow.id,
        });
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleAddColumn = (rowId: string) => {
    try {
      const next = updatePageIfFree(
        addColumn(layout, currentPage.id, rowId),
        currentPage.id,
      );
      const row = next.pages
        .find((page) => page.id === currentPage.id)
        ?.rows.find((candidate) => candidate.id === rowId);
      const column = row?.columns[row.columns.length - 1];
      commitLayout(next);
      if (column !== undefined) {
        setSelected({
          kind: "column",
          pageId: currentPage.id,
          rowId,
          columnId: column.id,
        });
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleAddBlock = (type: NewBlockType) => {
    const target = getColumnTarget();
    if (target === null) {
      return;
    }
    try {
      const next = updatePageIfFree(
        addBlock(
          layout,
          currentPage.id,
          target.rowId,
          target.columnId,
          type,
        ),
        currentPage.id,
      );
      const block = next.pages
        .find((page) => page.id === currentPage.id)
        ?.rows.find((row) => row.id === target.rowId)
        ?.columns.find((column) => column.id === target.columnId)
        ?.blocks.slice(-1)[0];
      commitLayout(next);
      if (block !== undefined) {
        setSelected({
          kind: "block",
          pageId: currentPage.id,
          rowId: target.rowId,
          columnId: target.columnId,
          blockId: block.id,
        });
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const deleteSelected = () => {
    if (selected === null || selected.kind === "page") {
      return;
    }
    try {
      const next =
        selected.kind === "icon"
          ? deleteDetachedIcon(layout, selected)
          : selected.kind === "row"
            ? deleteRow(layout, currentPage.id, selected.rowId)
            : selected.kind === "column"
            ? deleteColumn(
                layout,
                currentPage.id,
                selected.rowId,
                selected.columnId,
              )
            : deleteBlock(
                layout,
                currentPage.id,
                selected.rowId,
                selected.columnId,
                selected.blockId,
              );
      commitLayout(next);
      if (selected.kind === "row") {
        setSelected({ kind: "page", pageId: currentPage.id });
      } else {
        setSelected({
          kind: "row",
          pageId: currentPage.id,
          rowId: selected.rowId,
        });
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleMove = (
    active: EditorDndData,
    target: EditorDndData,
  ) => {
    try {
      let next = layout;
      if (active.kind === "row") {
        if (target.rowId !== active.rowId) {
          next = moveRow(layout, currentPage.id, active.rowId, target.rowId);
        }
      } else if (active.kind === "column") {
        const targetColumnId =
          target.kind === "column" || target.kind === "block"
            ? target.columnId
            : undefined;
        next = moveColumn(
          layout,
          currentPage.id,
          active.rowId,
          active.columnId,
          target.rowId,
          targetColumnId,
        );
      } else {
        const targetRow = currentPage.rows.find(
          (row) => row.id === target.rowId,
        );
        const targetColumnId =
          target.kind === "row" ? targetRow?.columns[0]?.id : target.columnId;
        if (targetColumnId === undefined) {
          return;
        }
        next = moveBlock(
          layout,
          currentPage.id,
          active.blockId,
          target.rowId,
          targetColumnId,
          target.kind === "block" ? target.blockId : undefined,
        );
      }
      commitLayout(next);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleSave = async () => {
    try {
      setSaveState("saving");
      await repository.saveDraft(layout);
      setSaveState("saved");
      setErrorMessage(null);
      setNoticeMessage("Brouillon enregistré avec succès.");
    } catch (error) {
      setSaveState("error");
      setErrorMessage(`Impossible d’enregistrer le brouillon : ${getErrorMessage(error)}`);
    }
  };

  useEffect(() => {
    if (noticeMessage === null) return;
    const t = window.setTimeout(() => setNoticeMessage(null), 3000);
    return () => window.clearTimeout(t);
  }, [noticeMessage]);

  const handlePublish = async () => {
    try {
      await repository.saveDraft(layout);
      await repository.publishDraft(layout.layoutId);
      setRevisions(await repository.listRevisions(layout.layoutId));
      setSaveState("saved");
      setErrorMessage(null);
      setNoticeMessage("Brouillon enregistré avec succès.");
      setNoticeMessage("Les versions locales ont été mises à jour. L’application n’a pas été modifiée.");
    } catch (error) {
      setErrorMessage(`Impossible de créer la version locale : ${getErrorMessage(error)}`);
    }
  };

  const handleRestoreRevision = async () => {
    if (selectedRevisionId === "") {
      return;
    }
    try {
      await repository.restoreRevision(layout.layoutId, selectedRevisionId);
      const restored = await repository.loadDraft(layout.layoutId);
      if (restored === null) {
        throw new Error("La restauration n’a produit aucun brouillon.");
      }
      commitLayout(restored);
      setRevisions(await repository.listRevisions(layout.layoutId));
      setErrorMessage(null);
      setNoticeMessage("La révision a été restaurée dans le brouillon.");
    } catch (error) {
      setErrorMessage(`Impossible de restaurer la révision : ${getErrorMessage(error)}`);
    }
  };

  const handleAddPage = () => {
    try {
      const result = addPage(layout);
      commitLayout(result.layout);
      setCurrentPageId(result.pageId);
      setSelected({ kind: "page", pageId: result.pageId });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handleLayoutModeChange = (value: string) => {
    if (value !== "flow" && value !== "free") {
      return;
    }
    if (value === currentPage.layoutMode) {
      return;
    }
    try {
      const updatedPage =
        value === "free"
          ? convertPageToFreeLayout(currentPage)
          : { ...currentPage, layoutMode: "flow" as const };
      commitLayout({
        ...layout,
        pages: layout.pages.map((page) =>
          page.id === currentPage.id ? updatedPage : page,
        ),
      });
      setSelected({ kind: "page", pageId: currentPage.id });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    }
  };

  const handlePreviewAction = (actionId: string) => {
    if (!isDemoAction(actionId)) {
      setPreviewMessage("Cette action n’est pas autorisée dans l’aperçu.");
    } else if (actionId === "demo.show-welcome") {
      setPreviewMessage("Action de démonstration exécutée; aucune action réelle n’a été lancée.");
    } else {
      setPreviewMessage("Aucune opération n’est associée à cette action de démonstration.");
    }
  };

  const columnTarget = getColumnTarget();

  if (!isStorageReady) {
    return (
      <main className="layout-editor">
        <p role="status">Chargement du brouillon local…</p>
      </main>
    );
  }

  return (
    <main className="layout-editor">
      <header className="layout-editor-toolbar">
         <div className="layout-editor-title">
           <h1>Éditeur visuel</h1>
           <span>Mode développement uniquement</span>
         </div>
         <select value={selectedPageId} onChange={(e) => setSelectedPageId(e.target.value)} style={{ marginLeft: 12 }}>
           {PAGE_REGISTRY.map((p) => (
             <option key={p.id} value={p.id}>{p.title} ({p.status})</option>
           ))}
         </select>
         <span style={{ marginLeft: 12, fontSize: 12 }}>
           {(() => {
             const s = repository instanceof SyncingLayoutRepository ? repository.syncStatus : "synced";
             if (s === "conflict") {
               return (
                 <>
                   Conflit détecté.
                   <button type="button" onClick={() => repository instanceof SyncingLayoutRepository && repository.resolveConflict("local")}>Garder local</button>
                   <button type="button" onClick={() => repository instanceof SyncingLayoutRepository && repository.resolveConflict("server")}>Garder serveur</button>
                 </>
               );
             }
             return s;
           })()}
         </span>
        <div className="layout-editor-toolbar-controls">
          {!isPreview && (
            <>
              <label>
                Page
                <select
                  value={currentPage.id}
                  onChange={(event) => {
                    setCurrentPageId(event.target.value);
                    setSelected({
                      kind: "page",
                      pageId: event.target.value,
                    });
                  }}
                >
                  {layout.pages.map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Placement
                <select
                  aria-label="Mode de placement"
                  value={currentPage.layoutMode}
                  onChange={(event) => handleLayoutModeChange(event.target.value)}
                >
                  <option value="flow">Flux (grille)</option>
                  <option value="free">Libre</option>
                </select>
              </label>
              <button type="button" onClick={handleAddPage}>
                + Page
              </button>
              <button
                type="button"
                disabled={history.past.length === 0}
                onClick={handleUndo}
              >
                Annuler
              </button>
              <button
                type="button"
                disabled={history.future.length === 0}
                onClick={handleRedo}
              >
                Rétablir
              </button>
              <button type="button" onClick={() => void handleSave()} disabled={saveState === "saving"}>
                Enregistrer
              </button>
              {noticeMessage !== null && (
                <span style={{ marginLeft: 8, fontSize: 12, color: "#16a34a" }}>{noticeMessage}</span>
              )}
              {errorMessage !== null && (
                <span style={{ marginLeft: 8, fontSize: 12, color: "#dc2626" }}>{errorMessage}</span>
              )}
              <button type="button" onClick={() => void handlePublish()}>
                Créer une version locale
              </button>
              {revisions.length > 0 && (
                <>
                  <label>
                    Révision
                    <select
                      value={selectedRevisionId}
                      onChange={(event) =>
                        setSelectedRevisionId(event.target.value)
                      }
                    >
                      <option value="">Choisir…</option>
                      {revisions.map((revision) => (
                        <option
                          key={revision.revisionId}
                          value={revision.revisionId}
                        >
                          {new Date(revision.createdAt).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={selectedRevisionId === ""}
                    onClick={() => void handleRestoreRevision()}
                  >
                    Restaurer
                  </button>
                </>
              )}
            </>
          )}
          <label>
            Aperçu
            <select
              aria-label="Aperçu"
              value={device}
              onChange={(event) => {
                if (isDevicePreview(event.target.value)) {
                  setDevice(event.target.value);
                }
              }}
            >
              <option value="mobile">Mobile</option>
              <option value="tablet">Tablette</option>
              <option value="desktop">Bureau</option>
            </select>
          </label>
          <button type="button" onClick={() => {
            setIsPreview((value) => !value);
            setPreviewMessage(null);
          }}>
            {isPreview ? "Quitter l’aperçu" : "Prévisualiser"}
          </button>
        </div>
      </header>

      <div className="layout-editor-status" aria-live="polite">
        <span>
          {saveState === "loading"
            ? "Chargement…"
            : saveState === "saving"
              ? "Enregistrement…"
              : saveState === "error"
                ? "Erreur de stockage"
                : "Brouillon enregistré"}
        </span>
        {errorMessage !== null && (
          <p className="layout-editor-error" role="alert">
            {errorMessage}
          </p>
        )}
        {noticeMessage !== null && (
          <p className="layout-editor-notice" role="status">
            {noticeMessage}
          </p>
        )}
      </div>

      {isPreview ? (
        <section className={`layout-editor-preview layout-page--${device}`}>
          <LayoutRenderer
            layout={layout}
            pageId={currentPage.id}
            responsiveMode={device}
            onAction={handlePreviewAction}
          />
          {previewMessage !== null && (
            <p className="layout-editor-preview-message" role="status">
              {previewMessage}
            </p>
          )}
        </section>
      ) : (
        <div className="layout-editor-workspace">
          <ComponentLibrary
            rowTargetId={getRowTargetId()}
            columnTargetId={columnTarget?.columnId ?? null}
            onAddRow={handleAddRow}
            onAddColumn={handleAddColumn}
            onAddBlock={handleAddBlock}
          />
          <EditorCanvas
            page={currentPage}
            selected={selected}
            device={device}
            onSelect={setSelected}
            onAddColumn={handleAddColumn}
            onDeleteRow={(rowId) => {
              try {
                commitLayout(deleteRow(layout, currentPage.id, rowId));
                setSelected({ kind: "page", pageId: currentPage.id });
              } catch (error) {
                setErrorMessage(getErrorMessage(error));
              }
            }}
            onDeleteColumn={(rowId, columnId) => {
              try {
                commitLayout(
                  deleteColumn(layout, currentPage.id, rowId, columnId),
                );
                setSelected({ kind: "row", pageId: currentPage.id, rowId });
              } catch (error) {
                setErrorMessage(getErrorMessage(error));
              }
            }}
            onDeleteBlock={(rowId, columnId, blockId) => {
              try {
                commitLayout(
                  deleteBlock(
                    layout,
                    currentPage.id,
                    rowId,
                    columnId,
                    blockId,
                  ),
                );
                setSelected({
                  kind: "column",
                  pageId: currentPage.id,
                  rowId,
                  columnId,
                });
              } catch (error) {
                setErrorMessage(getErrorMessage(error));
              }
            }}
            onMove={handleMove}
            onTransformStart={handleTransformStart}
            onTransformPreview={handleTransformPreview}
            onTransformCommit={handleTransformCommit}
            onTransformCancel={handleTransformCancel}
          />
          <PropertiesPanel
            layout={displayLayout}
            selection={selected}
            device={device}
            onMoveLayer={handleMoveLayer}
            onLayoutChange={commitLayout}
            onDelete={deleteSelected}
          />
        </div>
      )}
      {isPreview && (
        <p className="layout-editor-preview-note">
          Les actions ci-dessus sont simulées et ne déclenchent aucune opération de l’application.
        </p>
      )}
    </main>
  );
}
