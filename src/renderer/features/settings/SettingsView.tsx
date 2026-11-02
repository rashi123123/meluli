import { FolderOpen } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ShortcutEditor } from "@/components/ShortcutEditor";
import { useAppContext } from "@/context/app-context";
import { useMicrophoneDevices } from "@/hooks/use-microphone-devices";
import { formatBytes } from "@/lib/bytes";
import { UPDATE_FEED_URL } from "@shared/constants";
import { he } from "@shared/locale";
import type { HoldKeyChoice } from "@shared/types";
import { usePendingActions } from "@/hooks/use-pending-actions";
import { OverlayPositionPicker } from "./OverlayPositionPicker";
import { SettingsRow } from "./SettingsRow";
import { getHebrewErrorMessage } from "@shared/error-utils";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ThemePicker } from "./ThemePicker";

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-group"><h3>{title}</h3><div className="settings-rows">{children}</div></section>;
}

export function SettingsView() {
  const {
    settings,
    modelProgress,
    permissionStatus,
    accessibilityPermissionStatus,
    appState,
    updateSetting,
    requestMicrophonePermission,
    requestAccessibilityPermission,
    downloadModel,
    revealStorage,
    rerunOnboarding,
    resetEverything
  } = useAppContext();
  const { pendingActions, pendingActionsRef, runAction, switchBusy } = usePendingActions();
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [holdKeyAsked, setHoldKeyAsked] = useState(false);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const resetCancel = useRef<HTMLButtonElement>(null);
  const resetWasOpen = useRef(false);
  const resetTitleId = useId();
  const resetDescriptionId = useId();
  const overlayPositionId = useId();
  const overlayPositionDescriptionId = useId();
  const themeLabelId = useId();
  const launchAtLoginLabelId = useId();
  const launchAtLoginDescriptionId = useId();
  const microphoneInputId = useId();
  const microphoneInputDescriptionId = useId();
  const holdKeyInputId = useId();
  const holdKeyDescriptionId = useId();
  const fillerWordsLabelId = useId();
  const fillerWordsDescriptionId = useId();
  const spokenCommandsLabelId = useId();
  const spokenCommandsDescriptionId = useId();
  const autoUpdateLabelId = useId();
  const callDetectionLabelId = useId();
  const callDetectionDescriptionId = useId();
  const autoUpdateDescriptionId = useId();
  const notificationsLabelId = useId();
  const notificationsDescriptionId = useId();

  const microphoneDevices = useMicrophoneDevices(settings?.microphoneDeviceId, permissionStatus);

  useEffect(() => {
    if (showResetConfirm) resetCancel.current?.focus();
    else if (resetWasOpen.current) resetTrigger.current?.focus();
    resetWasOpen.current = showResetConfirm;
  }, [showResetConfirm]);

  if (!settings) return null;

  const modelProgressLabel = settings.modelState.downloadState !== "downloading" ? null : modelProgress?.percent != null
    ? `${modelProgress.percent}%`
    : modelProgress && modelProgress.bytesDownloaded > 0
      ? modelProgress.totalBytes
        ? `${formatBytes(modelProgress.bytesDownloaded)} / ${formatBytes(modelProgress.totalBytes)}`
        : `${formatBytes(modelProgress.bytesDownloaded)} ${he.bytesDownloadedSuffix}`
      : null;

  const modelStateLabel = {
    missing: he.modelMissing,
    downloading: he.modelDownloading,
    ready: "מוכן. התמלול רץ על המחשב שלך.",
    error: he.modelDownloadFailed
  }[settings.modelState.downloadState];
  const modelError = settings.modelState.downloadState === "error"
    ? getHebrewErrorMessage(settings.modelState.lastError, he.modelDownloadFailed) : null;

  const modelState = settings.modelState.downloadState;
  const modelPercent = modelState === "downloading" ? modelProgress?.percent ?? null : null;
  const microphoneBlocked = permissionStatus === "denied" || permissionStatus === "restricted";
  const actionBusy = switchBusy;
  const updateStatus = appState.update?.status ?? "off";
  const updateMessage = updateStatus === "downloading" ? he.updateDownloading : updateStatus === "ready" ? he.updateReady
    : updateStatus === "failed" ? he.updateFailed : he.autoUpdateDescription;
  const holdKeyStatus = appState.holdKey?.status ?? "off";
  const holdKeyBlocked = settings.holdKey !== "off" && holdKeyStatus === "needs_permission";
  const holdKeyMessage = holdKeyBlocked ? he.holdKeyPermissionNeeded : holdKeyStatus === "unavailable" ? he.holdKeyUnavailable : he.holdKeyDescription;
  // macOS asks only once, so a second click has to lead somewhere the person can act.
  const askHoldKey = async () => {
    if (holdKeyAsked) await window.ivritMenuBar.permissions.openHoldKeySettings();
    else {
      await window.ivritMenuBar.permissions.requestHoldKey();
      setHoldKeyAsked(true);
    }
  };

  return <div className="settings-groups">
    <SettingsGroup title={he.microphoneLabel}>
      <SettingsRow title={he.microphone} description={he.microphoneDescription}>
        {permissionStatus === "granted" ? <>
          <span className="permission-state" role="status"><span className="led" data-tone="ok" />מאושר</span>
          <Button size="sm" variant="ghost" {...actionBusy("microphonePermission")} onClick={() => void runAction("microphonePermission", () => window.ivritMenuBar.permissions.openMicrophoneSettings())}>הגדרות המערכת</Button>
        </> : microphoneBlocked ? <Button size="sm" variant="secondary" {...actionBusy("microphonePermission")} onClick={() => void runAction("microphonePermission", () => window.ivritMenuBar.permissions.openMicrophoneSettings())}>פתיחת הגדרות המערכת</Button>
          : <Button size="sm" {...actionBusy("microphonePermission")} onClick={() => void runAction("microphonePermission", requestMicrophonePermission)}>{he.allowMicrophone}</Button>}
      </SettingsRow>
      <div className="settings-row">
        <div className="settings-row-copy">
          <label className="settings-row-title" htmlFor={microphoneInputId}>{he.microphoneInput}</label>
          <span id={microphoneInputDescriptionId} className="settings-row-description">{he.microphoneSelectionDescription}</span>
        </div>
        <Select id={microphoneInputId} value={settings.microphoneDeviceId ?? ""} aria-describedby={microphoneInputDescriptionId} disabled={pendingActions.has("microphoneDeviceId")}
          onChange={(event) => { const deviceId = event.target.value || null; void runAction("microphoneDeviceId", () => updateSetting("microphoneDeviceId", deviceId)); }}>
          {settings.microphoneDeviceId && !microphoneDevices.devices.some((device) => device.deviceId === settings.microphoneDeviceId) ? <option value={settings.microphoneDeviceId}>{he.microphoneUnavailable}</option> : null}
          <option value="">{he.systemMicrophone}</option>
          {microphoneDevices.devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
        </Select>
      </div>
      <div className="settings-row">
        <div className="settings-row-copy">
          <label className="settings-row-title" htmlFor={holdKeyInputId}>{he.holdKeyLabel}</label>
          <span id={holdKeyDescriptionId} className="settings-row-description" role="status">{holdKeyMessage}</span>
        </div>
        <div className="settings-row-control">
          {holdKeyBlocked && <Button size="sm" variant="secondary" {...actionBusy("holdKeyPermission")} onClick={() => void runAction("holdKeyPermission", askHoldKey)}>{holdKeyAsked ? he.holdKeyOpenSettings : he.holdKeyAllow}</Button>}
          <Select id={holdKeyInputId} value={settings.holdKey} aria-describedby={holdKeyDescriptionId} disabled={pendingActions.has("holdKey")}
            onChange={(event) => { const key = event.target.value as HoldKeyChoice; void runAction("holdKey", () => updateSetting("holdKey", key)); }}>
            <option value="right_option">{he.holdKeyRightOption}</option>
            <option value="right_command">{he.holdKeyRightCommand}</option>
            <option value="off">{he.holdKeyOff}</option>
          </Select>
        </div>
      </div>
      <div className="settings-row"><ShortcutEditor id="recording-shortcut-editor" label={he.recordingShortcutLabel} description={he.recordingShortcutDescription} value={settings.shortcut} onSave={(value) => updateSetting("shortcut", value)} /></div>
      <div className="settings-row"><ShortcutEditor id="overlay-shortcut-editor" label={he.overlayShortcutLabel} description={he.overlayShortcutDescription} value={settings.overlayShortcut} onSave={(value) => updateSetting("overlayShortcut", value)} /></div>
      <div className="settings-row">
        <div className="settings-row-copy">
          <span id={overlayPositionId} className="settings-row-title">{he.overlayPositionLabel}</span>
          <span id={overlayPositionDescriptionId} className="settings-row-description">{he.overlayPositionDescription}</span>
        </div>
        <OverlayPositionPicker value={settings.overlayPosition} labelledBy={overlayPositionId} describedBy={overlayPositionDescriptionId}
          onChange={(position) => void runAction("overlayPosition", () => updateSetting("overlayPosition", position))} />
      </div>
      <SettingsRow title={he.accessibility} description={he.accessibilityDescription}>
        {accessibilityPermissionStatus === "granted"
          ? <span className="permission-state" role="status"><span className="led" data-tone="ok" />מאושר</span>
          : <Button size="sm" variant="secondary" {...actionBusy("accessibilityPermission")} onClick={() => void runAction("accessibilityPermission", requestAccessibilityPermission)}>{he.allowAccessibility}</Button>}
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={he.transcription}>
      <SettingsRow title="מנוע התמלול" description={<><span role="status">{modelStateLabel}</span>{modelProgressLabel ? ` (${modelProgressLabel})` : ""}{modelError && modelError !== modelStateLabel ? ` ${modelError}` : ""}</>}
        detail={modelState === "downloading" && <div className="progress-row"><div className="progress-track" role="progressbar" aria-label={he.modelDownloading} aria-valuemin={0} aria-valuemax={100} aria-valuenow={modelPercent ?? undefined}><div className="progress-fill" style={{ transform: `scaleX(${(modelPercent ?? 0) / 100})` }} /></div></div>}>
        {(modelState === "missing" || modelState === "error") && <Button size="sm" variant={modelState === "missing" ? "default" : "secondary"} onClick={() => void runAction("downloadModel", () => downloadModel().catch(() => undefined))}>
          {modelState === "error" ? he.retry : he.downloadHebrewModel}
        </Button>}
      </SettingsRow>
      <SettingsRow title={he.removeFillerWords} titleId={fillerWordsLabelId} description={he.removeFillerWordsDescription} descriptionId={fillerWordsDescriptionId}>
        <Switch checked={settings.removeFillerWords} aria-labelledby={fillerWordsLabelId} aria-describedby={fillerWordsDescriptionId} {...switchBusy("removeFillerWords")}
          onCheckedChange={(checked) => void runAction("removeFillerWords", () => updateSetting("removeFillerWords", checked))} />
      </SettingsRow>
      <SettingsRow title={he.spokenCommands} titleId={spokenCommandsLabelId} description={he.spokenCommandsDescription} descriptionId={spokenCommandsDescriptionId}>
        <Switch checked={settings.spokenCommands} aria-labelledby={spokenCommandsLabelId} aria-describedby={spokenCommandsDescriptionId} {...switchBusy("spokenCommands")}
          onCheckedChange={(checked) => void runAction("spokenCommands", () => updateSetting("spokenCommands", checked))} />
      </SettingsRow>
      {appState.call?.available && <SettingsRow title={he.callDetection} titleId={callDetectionLabelId} description={he.callDetectionDescription} descriptionId={callDetectionDescriptionId}>
        <Switch checked={settings.callDetection} aria-labelledby={callDetectionLabelId} aria-describedby={callDetectionDescriptionId} {...switchBusy("callDetection")}
          onCheckedChange={(checked) => void runAction("callDetection", () => updateSetting("callDetection", checked))} />
      </SettingsRow>}
      <SettingsRow title={he.completionNotifications} titleId={notificationsLabelId} description={he.completionNotificationsDescription} descriptionId={notificationsDescriptionId}>
        <Switch checked={settings.completionNotificationsEnabled} aria-labelledby={notificationsLabelId} aria-describedby={notificationsDescriptionId} {...switchBusy("completionNotificationsEnabled")}
          onCheckedChange={(checked) => void runAction("completionNotificationsEnabled", () => updateSetting("completionNotificationsEnabled", checked))} />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={he.general}>
      <SettingsRow title={he.theme} titleId={themeLabelId} description={he.themeDescription}
        detail={<ThemePicker value={settings.theme} labelledBy={themeLabelId} onChange={(theme) => void runAction("theme", () => updateSetting("theme", theme))} />} />
      <SettingsRow title={he.launchAtLogin} titleId={launchAtLoginLabelId} description={he.launchAtLoginDescription} descriptionId={launchAtLoginDescriptionId}>
        <Switch checked={settings.launchAtLogin} aria-labelledby={launchAtLoginLabelId} aria-describedby={launchAtLoginDescriptionId} {...switchBusy("launchAtLogin")}
          onCheckedChange={(checked) => void runAction("launchAtLogin", () => updateSetting("launchAtLogin", checked))} />
      </SettingsRow>
      {UPDATE_FEED_URL && <SettingsRow title={he.autoUpdate} titleId={autoUpdateLabelId} description={<span role="status">{updateMessage}</span>} descriptionId={autoUpdateDescriptionId}>
        {updateStatus === "ready" ? <Button size="sm" onClick={() => void window.ivritMenuBar.app.installUpdate()}>{he.updateInstall}</Button>
          : <Switch checked={settings.autoUpdate} aria-labelledby={autoUpdateLabelId} aria-describedby={autoUpdateDescriptionId} {...switchBusy("autoUpdate")}
            onCheckedChange={(checked) => void runAction("autoUpdate", () => updateSetting("autoUpdate", checked))} />}
      </SettingsRow>}
      <SettingsRow title={he.storage} description="התמלולים והמנוע נשמרים על המחשב.">
        <Button size="sm" variant="secondary" {...actionBusy("revealStorage")} onClick={() => void runAction("revealStorage", revealStorage)}><FolderOpen />{he.revealStorage}</Button>
      </SettingsRow>
      <SettingsRow title="היכרות" description={he.rerunOnboardingDescription}>
        <Button size="sm" variant="secondary" {...actionBusy("rerunOnboarding")} onClick={() => void runAction("rerunOnboarding", rerunOnboarding)}>{he.rerunOnboarding}</Button>
      </SettingsRow>
    </SettingsGroup>

    <section className="settings-group">
      {showResetConfirm ? <div className="settings-reset-confirm inline-confirm" role="group" aria-labelledby={resetTitleId} aria-describedby={resetDescriptionId} aria-busy={pendingActions.has("reset")} onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault(); event.stopPropagation();
        if (!pendingActionsRef.current.has("reset")) setShowResetConfirm(false);
      }}>
        <div className="inline-confirm-copy"><strong id={resetTitleId}>{he.settingsResetConfirmTitle}</strong><p id={resetDescriptionId}>{he.settingsResetConfirmBody}</p></div>
        <div className="inline-confirm-actions">
          <Button ref={resetCancel} size="sm" variant="secondary" aria-disabled={pendingActions.has("reset")} onClick={() => { if (!pendingActionsRef.current.has("reset")) setShowResetConfirm(false); }}>{he.settingsResetCancel}</Button>
          <Button size="sm" variant="destructive" aria-disabled={pendingActions.has("reset")} onClick={async () => { if (await runAction("reset", resetEverything)) setShowResetConfirm(false); }}>{he.settingsResetConfirmButton}</Button>
        </div>
      </div> : <div className="settings-rows"><SettingsRow title={he.settingsResetEverything} description={he.settingsResetEverythingDescription}>
        <Button ref={resetTrigger} size="sm" variant="destructive" onClick={() => setShowResetConfirm(true)}>איפוס…</Button>
      </SettingsRow></div>}
    </section>
  </div>;
}
