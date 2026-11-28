import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LayoutDemoPage } from "./layout/demo/LayoutDemoPage";
import { LayoutEditor } from "./layout/editor/LayoutEditor";
import { ApiLayoutRepository } from "./layout/storage/ApiLayoutRepository";
import { SyncingLayoutRepository } from "./layout/storage/SyncingLayoutRepository";
import { appShellLayout } from "./layout/demo/appShellLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";

const searchParams = new URLSearchParams(window.location.search);
const isLayoutEditor =
  import.meta.env.DEV && searchParams.has("layout-editor");
const isLayoutPreview =
  import.meta.env.DEV && searchParams.has("layout-preview");

window.addEventListener(
  "error",
  (event: ErrorEvent) => {
    console.error("[window.error]", event.message, event.filename, event.lineno, event.colno, event.error);
  },
  true,
);

window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  console.error("[unhandledrejection]", event.reason);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
{isLayoutEditor ? (
  <LayoutEditor repository={new SyncingLayoutRepository(new ApiLayoutRepository("demo-project", "demo-app", "demo-home"))} initialLayout={appShellLayout} />
) : isLayoutPreview ? (
        <LayoutDemoPage />
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </React.StrictMode>,
);
