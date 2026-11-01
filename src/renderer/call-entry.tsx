import React from "react";
import type { Root } from "react-dom/client";
import CallApp from "./CallApp";
import "./globals.css";

export function mountCallApp(root: Root): void {
  root.render(
    <React.StrictMode>
      <CallApp />
    </React.StrictMode>
  );
}
