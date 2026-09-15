import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { loadCatalogue } from "./i18n";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

// Awaited before the first render so `tr` can stay synchronous in components:
// nothing should need a loading state to know what to call a button.
await loadCatalogue();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
