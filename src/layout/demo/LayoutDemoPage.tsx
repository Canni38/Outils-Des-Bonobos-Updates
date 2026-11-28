import { useState } from "react";
import { LayoutRenderer } from "../LayoutRenderer.tsx";
import type { LayoutActionHandler } from "../components/registry.tsx";
import { demoHomeLayout } from "./demoHomeLayout.ts";
import "./demo.css";

export function LayoutDemoPage() {
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  const handleAction: LayoutActionHandler = (actionId) => {
    if (actionId === "demo.show-welcome") {
      setActionStatus("L’action de démonstration a été déclenchée.");
    }
  };

  return (
    <main className="layout-demo-page">
      <header className="layout-demo-header">
        <p>Aperçu développeur — moteur de mise en page</p>
      </header>
      <div className="layout-demo-content">
        <LayoutRenderer layout={demoHomeLayout} onAction={handleAction} />
        {actionStatus !== null && (
          <p className="layout-demo-status" role="status">
            {actionStatus}
          </p>
        )}
      </div>
    </main>
  );
}
