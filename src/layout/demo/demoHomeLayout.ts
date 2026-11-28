import type { LayoutConfig } from "../schema/types.ts";

export const demoHomeLayout = {
  schemaVersion: 3,
  layoutId: "demo-home",
  pages: [
    {
      id: "home",
      title: "Accueil de démonstration",
      order: 0,
      layoutMode: "flow",
      rows: [
        {
          type: "row",
          id: "intro-row",
          columns: [
            {
              type: "column",
              id: "intro-main",
              span: { mobile: 12, tablet: 8, desktop: 8 },
              blocks: [
                {
                  type: "heading",
                  id: "welcome-heading",
                  name: "Titre d’accueil",
                  text: "Bienvenue chez les Bonobos",
                  level: 1,
                },
                {
                  type: "text",
                  id: "welcome-copy",
                  text: "Cette page est un aperçu indépendant du moteur de mise en page. Les blocs décrivent uniquement leur apparence; leurs actions restent fournies par l’application.",
                  tone: "default",
                },
              ],
            },
            {
              type: "column",
              id: "intro-aside",
              span: { mobile: 12, tablet: 4, desktop: 4 },
              blocks: [
                {
                  type: "card",
                  id: "responsive-note",
                  name: "Carte responsive",
                  title: "Mise en page responsive",
                  content: "Les colonnes utilisent une grille de 12 unités et s’adaptent aux formats mobile, tablette et bureau.",
                  alignment: "left",
                  spacing: "medium",
                },
              ],
            },
          ],
        },
        {
          type: "row",
          id: "actions-row",
          columns: [
            {
              type: "column",
              id: "actions-column",
              span: { mobile: 12, tablet: 12, desktop: 12 },
              blocks: [
                {
                  type: "separator",
                  id: "demo-separator",
                  name: "Séparateur d’exemple",
                  spacing: "small",
                },
                {
                  type: "button",
                  id: "demo-action",
                  name: "Action de démonstration",
                  label: "Tester l’action de démonstration",
                  actionId: "demo.show-welcome",
                  variant: "primary",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
} satisfies LayoutConfig;
