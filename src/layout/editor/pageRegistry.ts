export type PageStatus = "existing" | "planned";

export interface PageDescriptor {
  id: string;
  title: string;
  description: string;
  status: PageStatus;
  permission?: string;
}

export const PAGE_REGISTRY: PageDescriptor[] = [
  { id: "page.account", title: "Mon compte", description: "Résumé du compte Steam et permissions.", status: "existing", permission: "layouts.read" },
  { id: "page.permissions", title: "Mes permissions", description: "Liste des autorisations accordées.", status: "existing", permission: "layouts.read" },
  { id: "page.administration", title: "Administration", description: "Catalogue des permissions et réglages.", status: "existing", permission: "administration.access" },
  { id: "page.layout-editor", title: "Éditeur de mise en page", description: "Constructeur visuel BnB.", status: "existing", permission: "layouts.write" },
  { id: "page.players", title: "Présentation des joueurs", description: "Cartes et présentation des joueurs.", status: "planned", permission: "layouts.read" },
];
