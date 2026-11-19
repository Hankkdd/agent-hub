import { t } from "@/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/error-boundary";

// Follow the OS light/dark setting (shadcn's dark variant keys off the .dark class).
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label={t("app.name")}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
