// Menu, MenuItem, Tray and nativeImage over the native host (ElectronMenus.swift). Menus cross as
// templates whose items carry ids; a chosen item comes back as "menu-click" and its handler runs here.
import { EventEmitter } from "../node/events";
import { call, onHost, post, reportUncaught } from "./bridge";
import { app } from "./app";
import { imageDescriptor, type NativeImage } from "./image";
import type { BrowserWindow } from "./windows";

// ---------------------------------------------------------------------------------------------
// Menu

type ClickHandler = (item: MenuItem, window: BrowserWindow | undefined, event: Record<string, unknown>) => void;
interface MenuItemOptions {
  label?: string; type?: "normal" | "separator" | "submenu" | "checkbox" | "radio"; enabled?: boolean; visible?: boolean;
  checked?: boolean; icon?: NativeImage | string; toolTip?: string; sublabel?: string; id?: string; role?: string;
  accelerator?: string; click?: ClickHandler; submenu?: MenuItemOptions[] | Menu;
}

export class MenuItem {
  readonly label: string;
  readonly type: string;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
  readonly id: string | undefined;
  readonly role: string | undefined;
  readonly icon: NativeImage | string | undefined;
  readonly toolTip: string | undefined;
  readonly submenu: Menu | undefined;
  click: ClickHandler | undefined;
  /** @internal */ itemId = 0;

  constructor(options: MenuItemOptions) {
    this.submenu = options.submenu ? (options.submenu instanceof Menu ? options.submenu : Menu.buildFromTemplate(options.submenu)) : undefined;
    this.type = options.type ?? (this.submenu ? "submenu" : "normal");
    this.label = options.label ?? (options.role ? roleLabel(options.role) : "");
    this.enabled = options.enabled ?? true;
    this.visible = options.visible ?? true;
    this.checked = options.checked ?? false;
    this.id = options.id;
    this.role = options.role;
    this.icon = options.icon;
    this.toolTip = options.toolTip;
    this.click = options.click;
  }
}

function roleLabel(role: string): string {
  return ({ quit: `Quit ${app.getName()}`, about: `About ${app.getName()}`, hide: `Hide ${app.getName()}` } as Record<string, string>)[role] ?? role;
}

const liveMenus = new Map<number, Menu>();
let nextMenuId = 1;

export class Menu extends EventEmitter {
  static buildFromTemplate(template: Array<MenuItemOptions | MenuItem>): Menu {
    const menu = new Menu();
    for (const entry of template) menu.append(entry instanceof MenuItem ? entry : new MenuItem(entry));
    return menu;
  }
  static setApplicationMenu(_menu: Menu | null): void {}
  static getApplicationMenu(): Menu | null { return null; }

  readonly items: MenuItem[] = [];
  /** @internal */ readonly menuId = nextMenuId++;

  append(item: MenuItem): void { this.items.push(item); }
  insert(position: number, item: MenuItem): void { this.items.splice(position, 0, item); }
  getMenuItemById(id: string): MenuItem | null {
    for (const item of this.items) {
      if (item.id === id) return item;
      const found = item.submenu?.getMenuItemById(id);
      if (found) return found;
    }
    return null;
  }

  /** @internal The template Swift builds the NSMenu from. Every item gets an id within this menu. */
  serialize(): unknown[] {
    let next = 1;
    const index = new Map<number, MenuItem>();
    const walk = (items: MenuItem[]): unknown[] => items.map((item) => {
      item.itemId = next++;
      index.set(item.itemId, item);
      return {
        id: item.itemId, label: item.label, type: item.type, enabled: item.enabled, visible: item.visible, checked: item.checked,
        ...(item.icon ? { icon: imageDescriptor(item.icon) } : {}),
        ...(item.toolTip ? { toolTip: item.toolTip } : {}),
        ...(item.submenu ? { submenu: walk(item.submenu.items) } : {})
      };
    });
    const template = walk(this.items);
    this.index = index;
    return template;
  }
  private index = new Map<number, MenuItem>();

  /** @internal */ choose(itemId: number): void {
    const item = this.index.get(itemId);
    if (!item || !item.enabled) return;
    if (item.type === "checkbox") item.checked = !item.checked;
    if (item.role === "quit") return app.quit();
    try {
      item.click?.(item, undefined, {});
    } catch (error) {
      reportUncaught(error);
    }
  }

  popup(options: { window?: BrowserWindow; x?: number; y?: number; callback?: () => void } = {}): void {
    const template = this.serialize();
    liveMenus.set(this.menuId, this);
    this.emit("menu-will-show");
    const windowId = options.window && !options.window.isDestroyed() ? options.window.id : null;
    const hasPoint = typeof options.x === "number" && typeof options.y === "number";
    void call("menuPopup", this.menuId, template, windowId, hasPoint ? options.x : null, hasPoint ? options.y : null).then(() => {
      if (!trayMenus.has(this.menuId) && !retiredMenus.has(this.menuId)) liveMenus.delete(this.menuId);
      this.emit("menu-will-close");
      options.callback?.();
    });
  }

  closePopup(): void {}
}

const trayMenus = new Set<number>();

/** A tray menu replaced while it is open stays on screen, and its items still carry its id. The tray
 * rebuilds its menu every second while a timer runs, so a replaced menu stays routable for a while. */
const RETIRED_MENU_MS = 5 * 60_000;
const retiredMenus = new Map<number, number>();

function retireTrayMenu(menuId: number): void {
  trayMenus.delete(menuId);
  const now = Date.now();
  retiredMenus.delete(menuId);
  retiredMenus.set(menuId, now);
  for (const [id, retiredAt] of retiredMenus) {
    if (now - retiredAt < RETIRED_MENU_MS) break;
    retiredMenus.delete(id);
    liveMenus.delete(id);
  }
}

function dropTrayMenu(menuId: number): void {
  trayMenus.delete(menuId);
  retiredMenus.delete(menuId);
  liveMenus.delete(menuId);
}

onHost("menu-click", (event: { menu: number; item: number }) => {
  liveMenus.get(Number(event.menu))?.choose(Number(event.item));
});

// ---------------------------------------------------------------------------------------------
// Tray

let nextTrayId = 1;

export class Tray extends EventEmitter {
  private readonly trayId = nextTrayId++;
  private destroyed = false;
  private menu: Menu | null = null;
  private title = "";

  constructor(image: NativeImage | string) {
    super();
    post("trayCreate", this.trayId, imageDescriptor(image));
  }

  setImage(image: NativeImage | string): void { if (!this.destroyed) post("traySetImage", this.trayId, imageDescriptor(image)); }
  setPressedImage(_image: NativeImage | string): void {}
  setToolTip(text: string): void { if (!this.destroyed) post("traySetToolTip", this.trayId, text); }
  setTitle(title: string, options: { fontType?: "monospaced" | "monospacedDigit" } = {}): void {
    if (this.destroyed) return;
    this.title = title;
    post("traySetTitle", this.trayId, title, options.fontType === "monospacedDigit" || options.fontType === "monospaced");
  }
  getTitle(): string { return this.title; }
  setIgnoreDoubleClickEvents(_ignore: boolean): void {}

  /** With a menu, a click opens it and no "click" event fires, as Electron does on macOS. */
  setContextMenu(menu: Menu | null): void {
    if (this.destroyed) return;
    if (this.menu && this.menu !== menu) retireTrayMenu(this.menu.menuId);
    this.menu = menu;
    if (!menu) return post("traySetContextMenu", this.trayId, 0, null);
    const template = menu.serialize();
    retiredMenus.delete(menu.menuId);
    trayMenus.add(menu.menuId);
    liveMenus.set(menu.menuId, menu);
    post("traySetContextMenu", this.trayId, menu.menuId, template);
  }

  popUpContextMenu(menu?: Menu): void { (menu ?? this.menu)?.popup(); }
  closeContextMenu(): void {}
  getBounds(): { x: number; y: number; width: number; height: number } { return { x: 0, y: 0, width: 0, height: 0 }; }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.menu) dropTrayMenu(this.menu.menuId);
    post("trayDestroy", this.trayId);
  }
}
