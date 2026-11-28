import type { LayoutConfig } from "../schema/types";

export const appShellLayout: LayoutConfig = {
  schemaVersion: 3,
  layoutId: "app-shell",
  pages: [
    {
      id: "page-shell",
      title: "Shell Bonobos",
      order: 0,
      layoutMode: "flow",
      rows: [
        {
          id: "row-topbar",
          type: "row",
          columns: [
            {
              id: "col-topbar",
              type: "column",
              span: { mobile: 12, tablet: 12, desktop: 12 },
              blocks: [
                { id: "blk-logo", type: "heading", text: "Bonobos FR", level: 1 },
                { id: "blk-logout", type: "button", label: "Déconnexion", actionId: "demo.noop", variant: "secondary" },
              ],
            },
          ],
        },
        {
          id: "row-body",
          type: "row",
          columns: [
            {
              id: "col-nav",
              type: "column",
              span: { mobile: 12, tablet: 4, desktop: 3 },
              blocks: [
                { id: "blk-nav-account", type: "button", label: "Mon compte", actionId: "demo.noop", variant: "secondary" },
                { id: "blk-nav-perms", type: "button", label: "Mes permissions", actionId: "demo.noop", variant: "secondary" },
                { id: "blk-nav-admin", type: "button", label: "Administration", actionId: "demo.noop", variant: "secondary" },
                { id: "blk-nav-editor", type: "button", label: "Éditeur de mise en page", actionId: "demo.noop", variant: "secondary" },
              ],
            },
            {
              id: "col-content",
              type: "column",
              span: { mobile: 12, tablet: 8, desktop: 9 },
              blocks: [
                { id: "blk-content-title", type: "heading", text: "Zone principale", level: 2 },
                { id: "blk-content-text", type: "text", text: "Contenu de la page active.", tone: "default" },
              ],
            },
          ],
        },
      ],
    },
  ],
};
