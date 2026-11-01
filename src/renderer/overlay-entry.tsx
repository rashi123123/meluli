import React from "react";
import type { Root } from "react-dom/client";
import OverlayApp from "./OverlayApp";
import "./globals.css";
import { OverlayAppProvider } from "./context/overlay-app-provider";

export function mountOverlayApp(root: Root): void {
  root.render(
    <React.StrictMode>
      <OverlayAppProvider>
        <OverlayApp />
      </OverlayAppProvider>
    </React.StrictMode>
  );
}
