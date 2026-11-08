import { IPC_CHANNELS } from "@shared/ipc-channels";
import type { AppWindowRole } from "@shared/window-role";

export type InvokeChannelAccess = "main-only" | "overlay-only" | "call-only" | "shared";

/** Every channel a renderer may invoke, and which windows may invoke it. */
export const INVOKE_CHANNEL_ACCESS = {
  [IPC_CHANNELS.recordingStart]: "shared",
  [IPC_CHANNELS.recordingPause]: "shared",
  [IPC_CHANNELS.recordingStop]: "shared",
  [IPC_CHANNELS.recordingSendAudio]: "shared",
  [IPC_CHANNELS.recordingAudioChunk]: "shared",
  [IPC_CHANNELS.recordingsList]: "main-only",
  [IPC_CHANNELS.recordingsTranscribe]: "main-only",
  [IPC_CHANNELS.recordingsDiscard]: "main-only",
  [IPC_CHANNELS.recordingsAudio]: "main-only",
  [IPC_CHANNELS.dictationBegin]: "shared",
  [IPC_CHANNELS.dictationEnabled]: "shared",
  [IPC_CHANNELS.dictationChunk]: "shared",
  [IPC_CHANNELS.transcriptionCancel]: "shared",
  [IPC_CHANNELS.modelDownload]: "main-only",
  [IPC_CHANNELS.modelRemove]: "main-only",
  [IPC_CHANNELS.historyList]: "main-only",
  [IPC_CHANNELS.historySearch]: "main-only",
  [IPC_CHANNELS.historyUpdate]: "main-only",
  [IPC_CHANNELS.historyRestoreOriginal]: "main-only",
  [IPC_CHANNELS.historyDelete]: "main-only",
  [IPC_CHANNELS.historyDeleteAll]: "main-only",
  [IPC_CHANNELS.settingsGet]: "shared",
  [IPC_CHANNELS.settingsSet]: "main-only",
  [IPC_CHANNELS.fileImportAudio]: "main-only",
  [IPC_CHANNELS.fileImportDroppedAudio]: "main-only",
  [IPC_CHANNELS.fileExportTranscript]: "main-only",
  [IPC_CHANNELS.fileRevealPath]: "main-only",
  [IPC_CHANNELS.fileOpenExternal]: "main-only",
  [IPC_CHANNELS.fileStoragePaths]: "main-only",
  [IPC_CHANNELS.youtubeSubmit]: "main-only",
  [IPC_CHANNELS.youtubeCancelActive]: "main-only",
  [IPC_CHANNELS.youtubeCancelPending]: "main-only",
  [IPC_CHANNELS.permissionMicrophoneStatus]: "shared",
  [IPC_CHANNELS.permissionRequestMicrophone]: "shared",
  [IPC_CHANNELS.permissionOpenMicrophoneSettings]: "main-only",
  [IPC_CHANNELS.permissionAccessibilityStatus]: "shared",
  [IPC_CHANNELS.permissionRequestAccessibility]: "shared",
  [IPC_CHANNELS.permissionOpenAccessibilitySettings]: "main-only",
  [IPC_CHANNELS.permissionRequestHoldKey]: "main-only",
  [IPC_CHANNELS.permissionOpenHoldKeySettings]: "main-only",
  [IPC_CHANNELS.appState]: "shared",
  [IPC_CHANNELS.appIsMockMode]: "shared",
  [IPC_CHANNELS.appVersion]: "main-only",
  [IPC_CHANNELS.appInstallUpdate]: "main-only",
  [IPC_CHANNELS.appOpenLicenses]: "main-only",
  [IPC_CHANNELS.appReportMainWindow]: "main-only",
  [IPC_CHANNELS.appShowMain]: "overlay-only",
  [IPC_CHANNELS.overlayOpen]: "main-only",
  [IPC_CHANNELS.overlayRetarget]: "overlay-only",
  [IPC_CHANNELS.overlayReady]: "overlay-only",
  [IPC_CHANNELS.callAccept]: "call-only",
  [IPC_CHANNELS.callDismiss]: "call-only",
  [IPC_CHANNELS.callStop]: "call-only",
  [IPC_CHANNELS.callRetry]: "main-only",
  [IPC_CHANNELS.callDiscard]: "main-only",
  [IPC_CHANNELS.callDismissNotice]: "main-only",
  [IPC_CHANNELS.callOpenAudioSettings]: "main-only",
  [IPC_CHANNELS.overlayHide]: "overlay-only",
  [IPC_CHANNELS.overlaySetSize]: "overlay-only",
  [IPC_CHANNELS.overlaySetHeldRecording]: "overlay-only",
  [IPC_CHANNELS.textInsertIntoFocusedField]: "overlay-only",
  [IPC_CHANNELS.clipboardWriteText]: "shared",
  [IPC_CHANNELS.flowsState]: "main-only",
  [IPC_CHANNELS.flowsSave]: "main-only",
  [IPC_CHANNELS.flowsConnectionSave]: "main-only",
  [IPC_CHANNELS.flowsConnectionDelete]: "main-only",
  [IPC_CHANNELS.flowsConnectionTest]: "main-only",
  [IPC_CHANNELS.flowsTestRun]: "main-only",
  [IPC_CHANNELS.flowsTestDictation]: "main-only",
  [IPC_CHANNELS.flowsListApps]: "main-only",
  [IPC_CHANNELS.flowsConnectionDefault]: "main-only",
  [IPC_CHANNELS.flowsChoose]: "overlay-only",
  [IPC_CHANNELS.flowsPreview]: "overlay-only",
  [IPC_CHANNELS.flowsRevert]: "overlay-only"
} as const satisfies Readonly<Record<string, InvokeChannelAccess>>;

export type InvokeChannelName = keyof typeof INVOKE_CHANNEL_ACCESS;

export function canWindowRoleAccessChannel(role: AppWindowRole, channel: InvokeChannelName): boolean {
  const access: InvokeChannelAccess | undefined = INVOKE_CHANNEL_ACCESS[channel];
  if (!access) {
    return false;
  }

  if (role === "call") {
    return access === "call-only" || channel === IPC_CHANNELS.appState || channel === IPC_CHANNELS.settingsGet;
  }

  if (access === "shared") {
    return true;
  }

  if (access === "main-only") {
    return role === "main";
  }

  return access === "overlay-only" && role === "overlay";
}
