import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppState } from "@/hooks/use-app-state";
import { appSettingsSchema } from "@shared/schemas";
import type { AppSettings, OnboardingPhase } from "@shared/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
let state: ReturnType<typeof useAppState>;
let onChanged: ReturnType<typeof vi.fn>;
const settingsAt = (phase: OnboardingPhase) => appSettingsSchema.parse({
  onboarding: { phase, surface: "workspace", activatedAt: null, completedOptionalActions: [], dismissedOptionalActions: [] }
});
function Probe({ mode }: { mode: "main" | "overlay" }) {
  state = useAppState(mode);
  return null;
}
const render = async (mode: "main" | "overlay") => { await act(async () => root.render(<Probe mode={mode} />)); };

beforeEach(() => {
  onChanged = vi.fn(() => vi.fn());
  Object.assign(window, { ivritMenuBar: {
    settings: { get: vi.fn(async () => settingsAt("needs_first_transcript")), onChanged },
    app: { state: vi.fn(async () => ({ status: "idle" })), onState: vi.fn(() => vi.fn()) },
    permissions: { microphoneStatus: vi.fn(async () => "granted"), accessibilityStatus: vi.fn(async () => "granted") },
    files: { storagePaths: vi.fn(async () => null) },
    model: { onProgress: vi.fn(() => vi.fn()) },
    transcription: { onFailed: vi.fn(() => vi.fn()) }
  } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks();
  Reflect.deleteProperty(window, "ivritMenuBar");
});

describe("useAppState settings", () => {
  it("keeps the overlay current when setup finishes in the main window", async () => {
    await render("overlay");
    expect(state.settings?.onboarding.phase).toBe("needs_first_transcript");
    const publish = onChanged.mock.calls[0]?.[0] as (settings: AppSettings) => void;
    await act(async () => publish(settingsAt("activated")));
    expect(state.settings?.onboarding.phase).toBe("activated");
  });

  it("leaves the main window to its own onboarding queue", async () => {
    await render("main");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("reports a bootstrap failure instead of loading forever", async () => {
    vi.mocked(window.ivritMenuBar.settings.get).mockRejectedValue(new Error("database unavailable"));
    await render("main");
    expect(state.loadFailed).toBe(true);
  });
});
