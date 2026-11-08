// Page script for a development build (MELULI_NATIVE_PAGE_SCRIPT): IPC round trips through the
// preload API, then a file import of the fixture (MELULI_NATIVE_OPEN_PATHS) until its transcript
// shows in history. The body runs as an async function; its return value is page-script.json.
const api = window.ivritMenuBar;
const out = { steps: [] };
const step = async (name, run) => {
  const started = performance.now();
  try { const value = await run(); out.steps.push({ name, ms: Math.round(performance.now() - started), ok: true, value }); return value; }
  catch (error) { out.steps.push({ name, ms: Math.round(performance.now() - started), ok: false, error: String(error?.message ?? error) }); return undefined; }
};
const settings = await step("settings.get", async () => { const s = await api.settings.get(); return { keys: Object.keys(s).length, model: s.modelState?.downloadState, theme: s.theme }; });
await step("app.state", async () => (await api.app.state()).status);
const before = await step("history.list", async () => { const page = await api.history.list(5); return page.items.map((item) => item.id); });
await step("history.search.hebrew", async () => (await api.history.search("אני", 5)).items.length);
await step("dictionary", async () => { const d = api.dictionary ?? api.vocabulary; return d ? Object.keys(d) : "no dictionary api"; });
await step("files.storagePaths", async () => Object.keys(await api.files.storagePaths()));
const imported = await step("files.importAudio", () => api.files.importAudio());
const deadline = Date.now() + 180_000;
let found = null;
while (Date.now() < deadline && !found) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const page = await api.history.list(5);
  found = page.items.find((item) => !(before ?? []).includes(item.id)) ?? null;
}
out.transcript = found ? { source: found.sourceType ?? found.source_type, text: String(found.text ?? "").slice(0, 200), seconds: found.durationSeconds ?? found.duration } : null;
out.imported = imported === undefined ? null : JSON.parse(JSON.stringify(imported));
out.settings = settings;
return out;
