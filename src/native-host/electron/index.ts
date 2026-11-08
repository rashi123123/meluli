// The "electron" module for the native host (D20): the bundler resolves `import ... from "electron"`
// in src/main to this file. Each part mirrors the Electron API the app uses, over UIBridge.
import { app } from "./app";
import { BrowserWindow, ipcMain, session } from "./windows";
import { nativeImage } from "./image";
import { Menu, MenuItem, Tray } from "./menus";
import {
  autoUpdater, clipboard, contentTracing, dialog, globalShortcut, nativeTheme, Notification, powerMonitor, safeStorage, screen, shell,
  systemPreferences
} from "./system";

export {
  app, autoUpdater, BrowserWindow, clipboard, contentTracing, dialog, globalShortcut, ipcMain, Menu, MenuItem, nativeImage, nativeTheme,
  Notification, powerMonitor, safeStorage, screen, session, shell, systemPreferences, Tray
};

export default {
  app, autoUpdater, BrowserWindow, clipboard, contentTracing, dialog, globalShortcut, ipcMain, Menu, MenuItem, nativeImage, nativeTheme,
  Notification, powerMonitor, safeStorage, screen, session, shell, systemPreferences, Tray
};
