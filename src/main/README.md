# src/main — the app's main process

Runs in JavaScriptCore inside the Swift host (D20); `electron` and `node:*` imports resolve to the
shims in `src/native-host`. The entry is `index.ts`.

| Where | What |
|---|---|
| `index.ts` | Startup and wiring: single-instance lock, services, windows, tray, shortcuts, IPC. |
| `runtime.ts` | `AppRuntime`: the one state snapshot, recording ownership, events to the renderers. |
| `window.ts`, `main-window-host.ts` | The main, overlay and call windows and the main window's lifetime. |
| `overlay-*.ts`, `hold-to-talk.ts`, `shortcuts.ts` | The floating recorder: shortcut order, hold key, position and snapping. |
| `tray*.ts`, `theme.ts`, `app-icon.ts` | Menu bar item, theme and icon. |
| `security.ts`, `launch-switches.ts` | IPC sender checks, payload limits, allowed URLs, launch switches. |
| `system-permissions.ts` | Microphone and Accessibility state, and the privacy panes. |
| `ipc/` | `register.ts` is the composition root; `handlers/*` validate each channel; `registry.ts` and `policy.ts` decide which window may call what. |
| `services/` | The work: transcription, insertion and paste, flows, YouTube, models, updates, settings. `container.ts` builds them, the heavy ones on first use. |
| `services/insertion/` | Putting text into the user's app: paste journal, native paste helper client, clipboard bridge, bidi and per-app shaping. |
| `services/text-rules/` | Pure transcript text rules: numbers, terms, spoken commands, lists, contacts, self-corrections, pause punctuation. |
| `services/flows/` | Prompt flows: provider calls, keys, settings, the overlay flow picker, installed apps. |
| `services/youtube/` | YouTube import and its queue. |
| `services/calls/` | Call detection and two-track call transcription. |
| `db/` | SQLite: schema and migrations, settings and transcript repositories. |
| `config/` | Paths, the model manifest, mock mode. |
| `diagnostics/` | Pipeline trace and the perf audit (dev only). |

Paste path rules (journal, no retry, no double paste) live in `services/insertion/text-insertion.service.ts`,
`services/insertion/insertion-journal.ts` and `services/insertion/native-insertion-client.ts`.
