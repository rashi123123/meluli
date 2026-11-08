import { useEffect, useSyncExternalStore } from "react";

// Work the main window holds that a recreated window could not rebuild, such as unsaved text.
// While anything holds it, the main process keeps the hidden window instead of releasing it.
const holders = new Set<symbol>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export function useKeepMainWindow(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const id = Symbol("keep-main-window");
    holders.add(id);
    notify();
    return () => { holders.delete(id); notify(); };
  }, [active]);
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => holders.size > 0;

export function useMainWindowKept(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
