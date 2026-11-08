// The open windows, by id. A leaf so that `app` (quit closes every window) and `windows` (which adds
// and removes them) both use it without importing each other.
import type { BrowserWindow } from "./windows";

export const windows = new Map<number, BrowserWindow>();

export function allWindows(): BrowserWindow[] { return [...windows.values()]; }
