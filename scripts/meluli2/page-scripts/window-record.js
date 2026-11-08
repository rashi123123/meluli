// Page script (MELULI_NATIVE_PAGE_SCRIPT) for native-app-record-e2e.mjs: choose the named input the
// way the settings page does, press the window's record button, stop after the fixture has played
// into that input, and return the saved transcript. Nothing is pasted: window recordings never paste.
// The script takes no arguments, so the device name is fixed.
const device = "ZoomAudioDevice";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const api = window.ivritMenuBar;
const stages = [];
// Every wait has a limit, so a stuck step comes back named instead of leaving no result.
const within = (stage, promise, ms = 20_000) => {
  stages.push({ stage, at: Date.now() });
  return Promise.race([promise, sleep(ms).then(() => { throw new Error(`${stage} took over ${ms} ms`); })]);
};
// The start and stop cues stay silent: they would play through whatever the person is listening on.
OscillatorNode.prototype.connect = function (destination) { return destination; };
// Labels appear only once the page has had access. The probe opens only the input saved by an earlier
// run, and is closed before any audio is read: opening the default input could be someone's headset,
// and a Bluetooth headset switches to its call profile when its microphone opens.
const saved = (await within("settings.get", api.settings.get())).microphoneDeviceId;
if (!saved) return { error: `choose ${device} once in the test app's settings first`, stages };
let probe;
try {
  probe = await within("getUserMedia", navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: saved } } }));
} catch (error) {
  return { error: String(error), stages, visibility: document.visibilityState, focused: document.hasFocus() };
}
const probeTrack = probe.getAudioTracks()[0];
const probeSettings = { label: probeTrack?.label, ...(probeTrack?.getSettings() ?? {}) };
probe.getTracks().forEach((track) => track.stop());
if (probeSettings.label !== device) return { error: `the saved input is ${probeSettings.label}, not ${device}`, stages };
const inputs = (await within("enumerateDevices", navigator.mediaDevices.enumerateDevices())).filter((entry) => entry.kind === "audioinput");
const chosen = inputs.find((entry) => entry.label === device);
if (!chosen) return { error: "input not found", labels: inputs.map((entry) => entry.label) };
await within("settings.set", api.settings.set("microphoneDeviceId", chosen.deviceId));
// The recorder takes the device from the page's app state, which follows the saved setting. Pressing
// record before it arrives would open the default input, so the script waits for the page to show it.
const shown = () => document.querySelector(`.capture-area select[aria-label]`)?.value === chosen.deviceId;
for (let waited = 0; !shown(); waited += 100) {
  if (waited > 30_000) return { error: "the page never showed the chosen input", stages };
  await sleep(100);
}
stages.push({ stage: "input shown", at: Date.now() });
// The recorder's own stream, watched for mute and end while it records.
const trackEvents = [];
const getUserMedia = MediaDevices.prototype.getUserMedia;
MediaDevices.prototype.getUserMedia = async function (constraints) {
  const stream = await getUserMedia.call(this, constraints);
  for (const track of stream.getAudioTracks()) {
    trackEvents.push({ event: "open", at: Date.now(), label: track.label, settings: track.getSettings() });
    for (const name of ["mute", "unmute", "ended"]) track.addEventListener(name, () => trackEvents.push({ event: name, at: Date.now(), visibility: document.visibilityState }));
  }
  return stream;
};
const before = (await within("history.list", api.history.list(5))).items.map((item) => item.id);
const button = () => document.querySelector(".capture-area .record-action");
for (let tries = 0; tries < 50 && (!button() || button().disabled); tries += 1) await sleep(100);
const start = { label: button()?.getAttribute("aria-label"), disabled: button()?.disabled };
button()?.click();
const pressedAt = Date.now();
await sleep(11_000);
const stop = { label: button()?.getAttribute("aria-label"), status: document.querySelector(".capture-area")?.className };
button()?.click();
const stoppedAt = Date.now();
let found = null;
while (!found && Date.now() - stoppedAt < 120_000) {
  await sleep(500);
  found = (await api.history.list(5)).items.find((item) => !before.includes(item.id)) ?? null;
}
return {
  chosen: chosen.label, probeSettings, start, stop, recordMs: stoppedAt - pressedAt,
  transcript: found ? { text: found.text, sourceType: found.sourceType, durationMs: found.durationMs, stopToSavedMs: Date.now() - stoppedAt } : null,
  settingDevice: (await api.settings.get()).microphoneDeviceId === chosen.deviceId,
  stages,
  trackEvents: trackEvents.map((entry) => ({ ...entry, afterPressMs: entry.at - pressedAt })),
  errors: window.__meluliDiagnostics ?? []
};
