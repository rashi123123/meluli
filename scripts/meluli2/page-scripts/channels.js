// Page script for a development build (MELULI_NATIVE_PAGE_SCRIPT): the R4 channels through the
// preload API, in the test profile only. native-app-channels.mjs puts `const CONFIG = {...}` before
// this body: { exportPath, youtubeUrl }. Nothing here opens the microphone, pastes, or asks the
// system for a permission; completion notifications are turned off for the run and put back.
const api = window.ivritMenuBar;
const out = { steps: [] };
const step = async (name, run) => {
  const started = performance.now();
  try {
    const value = await Promise.race([run(), new Promise((_, reject) => setTimeout(() => reject(new Error("no answer in 60 s")), 60_000))]);
    out.steps.push({ name, ms: Math.round(performance.now() - started), ok: true, value });
    return value;
  } catch (error) { out.steps.push({ name, ms: Math.round(performance.now() - started), ok: false, error: String(error?.message ?? error) }); return undefined; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await step("app.version", () => api.app.version());
await step("app.state", async () => { const s = await api.app.state(); return { status: s.status, update: s.update, call: s.call ? Object.keys(s.call) : null }; });
const settings = await step("settings.get", async () => {
  const s = await api.settings.get();
  return { keys: Object.keys(s).length, launchAtLogin: s.launchAtLogin, callDetection: s.callDetection, notifications: s.completionNotificationsEnabled };
});
await step("permissions", async () => ({ microphone: await api.permissions.microphoneStatus(), accessibility: await api.permissions.accessibilityStatus() }));
await step("files.storagePaths", async () => Object.keys(await api.files.storagePaths()));
await step("flows.state", async () => { const s = await api.flows.state(); return { flows: s.flows?.length, connections: s.connections?.length }; });
await step("flows.listApps", async () => (await api.flows.listApps()).length);

// History, edits and the original.
const page = await step("history.list", async () => (await api.history.list(20)).items.map((item) => ({ id: item.id, sourceType: item.sourceType, length: item.text.length })));
const target = (page ?? []).find((item) => item.sourceType === "microphone") ?? (page ?? [])[0];
if (target) {
  const record = (await api.history.list(20)).items.find((item) => item.id === target.id);
  const original = record.text;
  await step("history.search", async () => (await api.history.search(original.split(/\s+/)[0], 5)).items.some((item) => item.id === target.id));
  // A timed transcript is edited cue by cue, as the editor does; a plain one as a whole.
  const cues = record.segments ?? [];
  const edit = cues.length
    ? { id: target.id, cueTexts: cues.map((cue, index) => (index === cues.length - 1 ? `${cue.text} בדיקה` : cue.text)) }
    : { id: target.id, text: `${original} בדיקה` };
  await step("history.update", async () => (await api.history.update(edit))?.text?.includes("בדיקה"));
  await step("history.restoreOriginal", async () => (await api.history.restoreOriginal(target.id))?.text === original);
  if (CONFIG.exportPath) await step("files.exportTranscript", () => api.files.exportTranscript(target.id));
}
// Kept audio: the WAV behind a kept recording, as the player gets it.
const kept = await step("recordings.list", async () => (await api.recordings.list()).map((item) => ({ id: item.id, status: item.status, transcriptId: item.transcriptId, durationMs: item.durationMs })));
const keptOne = (kept ?? []).find((item) => item.status === "kept") ?? (kept ?? [])[0];
if (keptOne) await step("recordings.audio", async () => {
  const bytes = await api.recordings.audio(keptOne.id);
  return bytes ? { bytes: bytes.length, header: String.fromCharCode(...bytes.slice(0, 4)), wave: String.fromCharCode(...bytes.slice(8, 12)), type: bytes.constructor.name } : null;
});

// Link import: a local address is refused before anything runs; a real video is downloaded and
// transcribed, and shows in history as a youtube transcript.
await step("youtube.refused", async () => { try { await api.youtube.submit({ url: "https://127.0.0.1/watch?v=x" }); return "accepted"; } catch (error) { return `refused: ${String(error?.message ?? error).slice(0, 80)}`; } });
if (CONFIG.youtubeUrl) {
  if (settings?.notifications) await api.settings.set("completionNotificationsEnabled", false);
  const before = new Set((await api.history.list(50)).items.map((item) => item.id));
  await step("youtube.submit", async () => (await api.youtube.submit({ url: CONFIG.youtubeUrl })).status);
  const deadline = Date.now() + 420_000;
  const seen = new Set();
  let found = null;
  while (Date.now() < deadline && !found) {
    await sleep(2000);
    const state = await api.app.state();
    seen.add(state.status);
    if (state.status === "error") { out.youtubeError = String(state.lastError ?? "").slice(0, 200); break; }
    found = (await api.history.list(10)).items.find((item) => !before.has(item.id) && item.sourceType === "youtube") ?? null;
  }
  out.youtube = { statuses: [...seen], transcript: found ? { title: found.sourceTitle ?? null, durationMs: found.durationMs, text: found.text.slice(0, 160) } : null };
  if (settings?.notifications) await api.settings.set("completionNotificationsEnabled", true);
}
return out;
