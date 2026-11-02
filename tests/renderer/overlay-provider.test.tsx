import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayAppProvider } from "@/context/overlay-app-provider";
import { useOverlayContext } from "@/context/overlay-context";
import { appSettingsSchema } from "@shared/schemas";

const appState = {
  loading: false, loadFailed: false, settings: appSettingsSchema.parse({}), appState: { status: "idle", timerStartedAt: null },
  permissionStatus: "granted", accessibilityPermissionStatus: "granted", modelProgress: null, storagePaths: null,
  setSettings: vi.fn(), setPermissionStatus: vi.fn(), setAccessibilityPermissionStatus: vi.fn()
};
const recording = { isPreparing: false, mediaStream: null };
vi.mock("@/hooks/use-app-state", () => ({ useAppState: () => appState }));
vi.mock("@/hooks/use-recording", () => ({ useRecording: () => recording }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(window, { ivritMenuBar: { transcription: { onFailed: () => () => undefined } } });
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); });

describe("overlay context", () => {
  it("gives the overlay the fields it reads and nothing from the main window", async () => {
    let seen: ReturnType<typeof useOverlayContext> | null = null;
    function Reader() { seen = useOverlayContext(); return null; }
    await act(async () => root.render(<OverlayAppProvider><Reader /></OverlayAppProvider>));
    expect(Object.keys(seen!).sort()).toEqual(["accessibilityPermissionStatus", "appState", "errorMessage", "loading", "onboarding", "permissionStatus",
      "recording", "requestAccessibilityPermission", "setErrorMessage", "settings"]);
  });

});
