/* @vitest-environment node */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { MainWindowHost } from "@main/main-window-host";
import type { MainView } from "@shared/types";

class FakeWindow extends EventEmitter {
  visible = false;
  destroyed = false;
  minimized = false;
  bounds = { x: 10, y: 20, width: 900, height: 700 };
  webContents = { id: Math.floor(Math.random() * 1e6) };
  constructor(readonly view: MainView | null) { super(); }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; }
  show() { if (!this.visible) { this.visible = true; this.emit("show"); } }
  hide() { if (this.visible) { this.visible = false; this.emit("hide"); } }
  focus() {}
  getBounds() { return this.bounds; }
  setBounds(bounds: FakeWindow["bounds"]) { this.bounds = bounds; }
  destroy() { this.destroyed = true; this.emit("closed"); }
}

function fixture({ mustKeep = () => false, quitting = () => false } = {} as { mustKeep?: (w: FakeWindow) => boolean; quitting?: () => boolean }) {
  const created: FakeWindow[] = [];
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
  const navigate = vi.fn();
  const attach = vi.fn();
  const host = new MainWindowHost({
    create: (view) => { const window = new FakeWindow(view); created.push(window); return window as never; },
    attach,
    mustKeep: (window) => mustKeep(window as never),
    navigate,
    isQuitting: quitting,
    releaseDelayMs: 30_000,
    setTimer: (run, ms) => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; }
  });
  const fire = () => { for (const timer of timers.splice(0)) if (!timer.cleared) timer.run(); };
  const pending = () => timers.filter((timer) => !timer.cleared).length;
  return { host, created, navigate, attach, fire, pending };
}

describe("MainWindowHost", () => {
  it("releases a window that stays hidden and recreates it on show with its bounds", () => {
    const { host, created, attach, fire } = fixture();
    host.show();
    created[0]!.setBounds({ x: 1, y: 2, width: 1000, height: 800 });
    host.hide();
    fire();
    expect(created[0]!.destroyed).toBe(true);
    expect(host.current).toBeNull();
    expect(host.releaseCount).toBe(1);

    host.show();
    expect(created).toHaveLength(2);
    expect(created[1]!.visible).toBe(true);
    expect(created[1]!.bounds).toEqual({ x: 1, y: 2, width: 1000, height: 800 });
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("keeps a window shown again before the delay ends", () => {
    const { host, created, fire, pending } = fixture();
    host.show();
    host.hide();
    created[0]!.show();
    expect(pending()).toBe(0);
    fire();
    expect(created[0]!.destroyed).toBe(false);
  });

  it("keeps a hidden window while the main process needs it, then releases it later", () => {
    let recording = true;
    const { host, created, fire, pending } = fixture({ mustKeep: () => recording });
    host.show();
    host.hide();
    fire();
    expect(created[0]!.destroyed).toBe(false);
    expect(pending()).toBe(1);
    recording = false;
    fire();
    expect(created[0]!.destroyed).toBe(true);
  });

  it("keeps a window whose renderer reports unsaved work and releases it once that is saved", () => {
    const { host, created, fire, pending } = fixture();
    host.show();
    const window = created[0]!;
    host.report(window.webContents, { view: "history", keep: true });
    host.hide();
    fire();
    expect(window.destroyed).toBe(false);
    host.report(window.webContents, { view: "history", keep: false });
    expect(pending()).toBe(1);
    fire();
    expect(window.destroyed).toBe(true);
  });

  it("ignores reports from any other sender", () => {
    const { host, created, fire } = fixture();
    host.show();
    host.report({ id: -1 }, { view: "settings", keep: true });
    host.hide();
    fire();
    expect(created[0]!.destroyed).toBe(true);
    host.show();
    expect(created[1]!.view).toBeNull();
  });

  it("reopens a released window on the last reported view, or the requested one", () => {
    const { host, created, fire, navigate } = fixture();
    host.show();
    host.report(created[0]!.webContents, { view: "dictionary", keep: false });
    host.hide();
    fire();
    host.show();
    expect(created[1]!.view).toBe("dictionary");
    expect(navigate).not.toHaveBeenCalled();

    host.hide();
    fire();
    host.show("settings");
    expect(created[2]!.view).toBe("settings");
    host.show("history");
    expect(navigate).toHaveBeenCalledWith("history");
    expect(created).toHaveLength(3);
  });

  it("never releases a window hidden some other way, such as minimized or covered", () => {
    const { host, created, fire, pending } = fixture();
    host.show();
    created[0]!.hide();
    expect(pending()).toBe(0);
    fire();
    expect(host.releaseIfIdle()).toBe(false);
    expect(created[0]!.destroyed).toBe(false);
    host.report(created[0]!.webContents, { view: "workspace", keep: true });
    host.report(created[0]!.webContents, { view: "workspace", keep: false });
    expect(pending()).toBe(0);
  });

  it("does not create a window while quitting", () => {
    const { host, created } = fixture({ quitting: () => true });
    expect(host.show()).toBeNull();
    expect(created).toHaveLength(0);
  });

  it("never releases while quitting or visible", () => {
    let ending = false;
    const quitting = fixture({ quitting: () => ending });
    quitting.host.show();
    quitting.host.hide();
    ending = true;
    expect(quitting.host.releaseIfIdle()).toBe(false);
    expect(quitting.created[0]!.destroyed).toBe(false);

    const visible = fixture();
    visible.host.show();
    expect(visible.host.releaseIfIdle()).toBe(false);
  });

  it("toggles between hidden and shown, recreating when released", () => {
    const { host, created, fire } = fixture();
    host.toggle();
    expect(created[0]!.visible).toBe(true);
    host.toggle();
    expect(created[0]!.visible).toBe(false);
    fire();
    host.toggle();
    expect(created).toHaveLength(2);
    expect(created[1]!.visible).toBe(true);
  });
});
