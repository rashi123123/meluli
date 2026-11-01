import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { AccessibilityPermissionStatus, HoldKeyStatus, MicrophonePermissionStatus } from "@shared/types";
import { IpcRegistry } from "../registry";

export function registerPermissionHandlers(
  registry: IpcRegistry,
  dependencies: {
    onMicrophoneStatus: () => MicrophonePermissionStatus | Promise<MicrophonePermissionStatus>;
    onRequestMicrophone: () => MicrophonePermissionStatus | Promise<MicrophonePermissionStatus>;
    onOpenMicrophoneSettings: () => boolean | Promise<boolean>;
    onAccessibilityStatus: () => AccessibilityPermissionStatus | Promise<AccessibilityPermissionStatus>;
    onRequestAccessibility: () => AccessibilityPermissionStatus | Promise<AccessibilityPermissionStatus>;
    onOpenAccessibilitySettings: () => boolean | Promise<boolean>;
    onRequestHoldKey: () => HoldKeyStatus | Promise<HoldKeyStatus>;
    onOpenHoldKeySettings: () => boolean | Promise<boolean>;
  }
): void {
  registry.register(IPC_CHANNELS.permissionMicrophoneStatus, () => dependencies.onMicrophoneStatus());
  registry.register(IPC_CHANNELS.permissionRequestMicrophone, () => dependencies.onRequestMicrophone());
  registry.register(IPC_CHANNELS.permissionOpenMicrophoneSettings, () => dependencies.onOpenMicrophoneSettings());
  registry.register(IPC_CHANNELS.permissionAccessibilityStatus, () => dependencies.onAccessibilityStatus());
  registry.register(IPC_CHANNELS.permissionRequestAccessibility, () => dependencies.onRequestAccessibility());
  registry.register(IPC_CHANNELS.permissionOpenAccessibilitySettings, () => dependencies.onOpenAccessibilitySettings());
  registry.register(IPC_CHANNELS.permissionRequestHoldKey, () => dependencies.onRequestHoldKey());
  registry.register(IPC_CHANNELS.permissionOpenHoldKeySettings, () => dependencies.onOpenHoldKeySettings());
}
