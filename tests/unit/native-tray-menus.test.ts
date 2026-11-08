/* @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ handlers: new Map<string, (payload: unknown) => void>(), posts: [] as unknown[][] }));

vi.mock("../../src/native-host/electron/bridge", () => ({
  call: vi.fn(() => new Promise(() => {})),
  onHost: (event: string, handler: (payload: unknown) => void) => { host.handlers.set(event, handler); return () => {}; },
  post: (...args: unknown[]) => { host.posts.push(args); },
  ui: vi.fn(),
  reportUncaught: vi.fn()
}));
vi.mock("../../src/native-host/electron/app", () => ({ app: { getName: () => "Meluli", quit: vi.fn() } }));

// Loaded by path at run time: the shim is typed for the native host, not for Node.
const shim = "../../src/native-host/electron/menus";

interface ShimMenu { menuId: number }
interface ShimModule {
  Menu: { buildFromTemplate(template: Array<{ label: string; click?: () => void }>): ShimMenu };
  Tray: new (image: string) => { setContextMenu(menu: ShimMenu | null): void; destroy(): void };
}

const click = (menu: ShimMenu, item = 1) => host.handlers.get("menu-click")?.({ menu: menu.menuId, item });

describe("tray menus in the native host", () => {
  let Menu: ShimModule["Menu"];
  let Tray: ShimModule["Tray"];

  beforeEach(async () => {
    vi.useFakeTimers();
    ({ Menu, Tray } = await import(/* @vite-ignore */ shim) as ShimModule);
  });
  afterEach(() => vi.useRealTimers());

  it("runs a click from a menu that was replaced while it was open", () => {
    const tray = new Tray("icon.png");
    const stop = vi.fn();
    const open = Menu.buildFromTemplate([{ label: "Stop 0:01", click: stop }]);
    tray.setContextMenu(open);
    // The recording timer rebuilds the menu every second.
    for (let second = 2; second <= 30; second++) {
      vi.advanceTimersByTime(1000);
      tray.setContextMenu(Menu.buildFromTemplate([{ label: `Stop 0:${second}`, click: vi.fn() }]));
    }
    click(open);
    expect(stop).toHaveBeenCalledTimes(1);
    tray.destroy();
  });

  it("forgets replaced menus after a while, and every menu once the tray is gone", () => {
    const tray = new Tray("icon.png");
    const old = vi.fn();
    const first = Menu.buildFromTemplate([{ label: "first", click: old }]);
    tray.setContextMenu(first);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "second" }]));
    vi.advanceTimersByTime(6 * 60_000);
    const current = vi.fn();
    const latest = Menu.buildFromTemplate([{ label: "latest", click: current }]);
    tray.setContextMenu(latest);
    click(first);
    expect(old).not.toHaveBeenCalled();
    click(latest);
    expect(current).toHaveBeenCalledTimes(1);
    tray.destroy();
    click(latest);
    expect(current).toHaveBeenCalledTimes(1);
  });
});
