import type { NewBlockType } from "./layoutOperations.ts";

interface ComponentLibraryProps {
  rowTargetId: string | null;
  columnTargetId: string | null;
  onAddRow: () => void;
  onAddColumn: (rowId: string) => void;
  onAddBlock: (type: NewBlockType) => void;
}

const availableBlocks: Array<{ type: NewBlockType; label: string }> = [
  { type: "heading", label: "Titre" },
  { type: "text", label: "Texte" },
  { type: "button", label: "Bouton" },
  { type: "card", label: "Carte / panneau" },
  { type: "separator", label: "Séparateur" },
];

export function ComponentLibrary({
  rowTargetId,
  columnTargetId,
  onAddRow,
  onAddColumn,
  onAddBlock,
}: ComponentLibraryProps) {
  return (
    <aside className="layout-editor-library">
      <h2>Bibliothèque</h2>
      <section className="layout-editor-library-section">
        <h3>Structure</h3>
        <button type="button" onClick={onAddRow}>
          + Ajouter une ligne
        </button>
        <button
          type="button"
          disabled={rowTargetId === null}
          onClick={() => {
            if (rowTargetId !== null) {
              onAddColumn(rowTargetId);
            }
          }}
        >
          + Ajouter une colonne
        </button>
        {rowTargetId === null && (
          <p>Pour ajouter une colonne, sélectionnez une ligne sur la page.</p>
        )}
      </section>
      <section className="layout-editor-library-section">
        <h3>Composants</h3>
        {availableBlocks.map(({ type, label }) => (
          <button
            disabled={columnTargetId === null}
            key={type}
            type="button"
            onClick={() => onAddBlock(type)}
          >
            + {label}
          </button>
        ))}
        {columnTargetId === null && (
          <p>Ajoutez ou sélectionnez une colonne pour y placer un composant.</p>
        )}
      </section>
      <p className="layout-editor-library-hint">
        En mode Flux, utilisez les poignées pour réorganiser les éléments. En
        mode Libre, glissez un objet et utilisez ses poignées de taille.
      </p>
    </aside>
  );
}
