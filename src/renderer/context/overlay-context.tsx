import { createContext, useContext } from "react";
import type { AppContextValue } from "./app-context";

export type OverlayContextValue = Pick<AppContextValue,
  | "loading" | "settings" | "onboarding" | "appState" | "recording" | "permissionStatus" | "accessibilityPermissionStatus"
  | "requestAccessibilityPermission" | "errorMessage" | "setErrorMessage">;

export const OverlayContext = createContext<OverlayContextValue | null>(null);

export function useOverlayContext(): OverlayContextValue {
  const context = useContext(OverlayContext);
  if (!context) {
    throw new Error("useOverlayContext must be used within the overlay provider.");
  }
  return context;
}
