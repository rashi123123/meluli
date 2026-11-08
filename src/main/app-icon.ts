import { app, nativeImage, type NativeImage } from "electron";
import { join } from "node:path";
import { resourcesRoot } from "./config/paths";

let cachedIcon: NativeImage | null = null;

export function resolveAppIconPath(): string {
  return join(resourcesRoot(app), "icons", "meluli-dock.png");
}

export function createAppIcon(): NativeImage {
  if (cachedIcon) {
    return cachedIcon;
  }

  const icon = nativeImage.createFromPath(resolveAppIconPath());
  cachedIcon = icon.isEmpty() ? nativeImage.createEmpty() : icon;
  return cachedIcon;
}
