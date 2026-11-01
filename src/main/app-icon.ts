import { app, nativeImage, type NativeImage } from "electron";
import { join } from "node:path";

let cachedIcon: NativeImage | null = null;

export function resolveAppIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "icons", "meluli-dock.png")
    : join(process.cwd(), "resources", "icons", "meluli-dock.png");
}

export function createAppIcon(): NativeImage {
  if (cachedIcon) {
    return cachedIcon;
  }

  const icon = nativeImage.createFromPath(resolveAppIconPath());
  cachedIcon = icon.isEmpty() ? nativeImage.createEmpty() : icon;
  return cachedIcon;
}
