import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppContext, type AppContextValue } from "@/context/app-context";
import { FlowsView } from "@/features/flows/FlowsView";
import { appSettingsSchema } from "@shared/schemas";
import type { FlowsState } from "@shared/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
const empty: FlowsState = { flows: [], connections: [], keyStorageAvailable: true };
const connected: FlowsState = { ...empty, connections: [{ id: "c1", providerId: "openai", baseUrl: "https://api.openai.com/v1", model: "m", consentedHost: "openrouter.ai", host: "openrouter.ai", local: false, hasKey: true, ready: true }] };
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes(label) || b.getAttribute("aria-label") === label)!;
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

function mount(state: FlowsState) {
  const api = {
    state: vi.fn().mockResolvedValue(state),
    save: vi.fn(async (flows) => ({ ...state, flows })),
    saveConnection: vi.fn().mockResolvedValue({ consented: true, state: connected }),
    deleteConnection: vi.fn().mockResolvedValue(empty),
    testConnection: vi.fn().mockResolvedValue({ ok: true, reason: null, latencyMs: 500, preview: "ok" }),
    testRun: vi.fn(), testDictation: vi.fn(), makeDefault: vi.fn(),
    listApps: vi.fn().mockResolvedValue([{ bundleId: "com.apple.mail", name: "Mail" }])
  };
  Object.assign(window, { ivritMenuBar: { flows: api, files: { openExternal: vi.fn() } } });
  const context = { settings: appSettingsSchema.parse({}) } as unknown as AppContextValue;
  return { api, render: () => act(async () => root.render(<AppContext.Provider value={context}><FlowsView /></AppContext.Provider>)) };
}

beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe("flows page", () => {
  it("starts from templates and asks for a connection first", async () => {
    const { api, render } = mount(empty);
    await render(); await flush();
    expect(host.textContent).toContain("התחילו מתבנית");
    await act(async () => button("מייל מקצועי").click());
    expect(host.textContent).toContain("חיבור למודל");
    // The consent names the host before anything is saved.
    expect(host.textContent).toContain("api.openai.com");
    type(host.querySelector<HTMLInputElement>('input[type="password"]')!, "sk-test");
    await act(async () => button("אישור וחיבור").click()); await flush();
    expect(api.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ providerId: "openai", baseUrl: "https://api.openai.com/v1" }), "sk-test", true);
    expect(api.testConnection).toHaveBeenCalledOnce();
    // The template is copied into a flow with the installed app it suggests.
    expect(host.querySelector<HTMLInputElement>(".flow-name")!.value).toBe("מייל מקצועי");
    expect(host.textContent).toContain("Mail");
  });

  it("does not keep a connection whose check failed", async () => {
    const { api, render } = mount(empty);
    api.testConnection.mockResolvedValueOnce({ ok: false, reason: "auth", latencyMs: null, preview: null });
    await render(); await flush();
    await act(async () => button("פעולה ריקה").click());
    type(host.querySelector<HTMLInputElement>('input[type="password"]')!, "sk-bad");
    await act(async () => button("אישור וחיבור").click()); await flush();
    expect(api.deleteConnection).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("הספק דחה את המפתח");
  });

  it("saves edits after a pause, under a placeholder name while the name is empty", async () => {
    const { api, render } = mount(connected);
    await render(); await flush();
    await act(async () => button("תרגום לאנגלית").click());
    type(host.querySelector<HTMLInputElement>(".flow-name")!, "  ");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(api.save).toHaveBeenCalled();
    expect(api.save.mock.calls.at(-1)![0][0].name).toBe("פעולה בלי שם");
  });

  it("lets the word count be cleared and retyped without writing 1", async () => {
    const { api, render } = mount(connected);
    await render(); await flush();
    await act(async () => button("תרגום לאנגלית").click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "תנאי")!.click());
    const words = () => host.querySelector<HTMLInputElement>('input[aria-label="מספר מילים"]')!;
    await act(async () => type(words(), ""));
    expect(words().value).toBe("");
    await act(async () => type(words(), "12"));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    const saved = api.save.mock.calls.at(-1)![0][0].steps.find((step: { kind: string }) => step.kind === "if");
    expect(saved.words).toBe(12);
    expect(api.save.mock.calls.flatMap(call => call[0][0].steps).some((step: { kind: string; words?: number }) => step.kind === "if" && step.words === 1)).toBe(false);
  });
});
