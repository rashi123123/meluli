import ReactDOM from "react-dom/client";
import { isThemeId } from "@shared/themes";
import { windowRoleFromQuery } from "@shared/window-role";
import { applyTheme } from "./lib/theme";

const query = new URLSearchParams(window.location.search);
const windowMode = windowRoleFromQuery(window.location.search) ?? "main";
const initialTheme = query.get("theme");

document.documentElement.dataset.windowMode = windowMode;
document.body.dataset.windowMode = windowMode;
// Painted before settings arrive over IPC, so a palette theme doesn't flash the default.
if (isThemeId(initialTheme)) applyTheme(initialTheme);

const root = ReactDOM.createRoot(document.getElementById("root")!);

async function mount(): Promise<void> {
  if (windowMode === "overlay") {
    const { mountOverlayApp } = await import("./overlay-entry");
    mountOverlayApp(root);
    return;
  }

  if (windowMode === "call") {
    const { mountCallApp } = await import("./call-entry");
    mountCallApp(root);
    return;
  }

  const { mountMainApp } = await import("./main-entry");
  mountMainApp(root);
}

void mount();
