import { IPC_CHANNELS } from "@shared/ipc-channels";
import { mainWindowReportSchema, mainViewSchema } from "@shared/schemas";
import type { AppStateSnapshot, MainView } from "@shared/types";
import { IpcRegistry } from "../registry";

export function registerAppHandlers(
  registry: IpcRegistry,
  dependencies: {
    getAppState: () => AppStateSnapshot;
    getIsMockMode: () => boolean;
    getVersion: () => string;
    onInstallUpdate: () => void;
    onOpenLicenses: () => Promise<void>;
    onShowMain: (view: MainView) => void;
    onMainWindowReport: (sender: unknown, state: { view: MainView; keep: boolean }) => void;
  }
): void {
  registry.register(IPC_CHANNELS.appState, () => dependencies.getAppState());
  registry.register(IPC_CHANNELS.appIsMockMode, () => dependencies.getIsMockMode());
  registry.register(IPC_CHANNELS.appVersion, () => dependencies.getVersion());
  registry.register(IPC_CHANNELS.appInstallUpdate, () => dependencies.onInstallUpdate());
  registry.register(IPC_CHANNELS.appOpenLicenses, () => dependencies.onOpenLicenses());
  registry.register(IPC_CHANNELS.appShowMain, (view) => dependencies.onShowMain(mainViewSchema.parse(view)));
  registry.register(IPC_CHANNELS.appReportMainWindow, (state, event) => dependencies.onMainWindowReport(event.sender, mainWindowReportSchema.parse(state)));
}
