import React from "react";
import type { Root } from "react-dom/client";
import App from "./App";
import "./globals.css";
import { MainAppProvider } from "./context/main-app-provider";

export function mountMainApp(root: Root): void {
  root.render(
    <React.StrictMode>
      <MainAppProvider>
        <App />
      </MainAppProvider>
    </React.StrictMode>
  );
}
