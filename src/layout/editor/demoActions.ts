export const demoActions = [
  { id: "demo.show-welcome", label: "Afficher un message de démonstration" },
  { id: "demo.noop", label: "Aucune action (démonstration)" },
] as const;

export type DemoActionId = (typeof demoActions)[number]["id"];

export function isDemoAction(actionId: string): actionId is DemoActionId {
  return demoActions.some((action) => action.id === actionId);
}
