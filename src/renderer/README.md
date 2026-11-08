# src/renderer — the three windows' React UI

Vite entries: `main-entry.tsx` (main window, `App.tsx`), `overlay-entry.tsx` (floating recorder,
`OverlayApp.tsx`), `call-entry.tsx` (call recorder, `CallApp.tsx`). `lab.html` is a dev-only
gallery of states with a mock bridge.

| Where | What |
|---|---|
| `features/` | One folder per screen: workspace, history, transcript, dictionary, flows, settings, onboarding, overlay, info. |
| `components/` | Shared pieces (buttons, glyphs, toasts, motion) and `ui/` primitives. |
| `context/` | App and overlay providers over `window.meluli`. |
| `hooks/` | Recording, microphone, transcripts, playback, pending actions. |
| `lib/` | Audio capture and worklet, PCM, formatting, shortcuts, sounds, theme. |
| `lab/` | The dev gallery (`lab.html`). |

All copy comes from `src/shared/locale.ts`. Renderer code reaches the main process only through
`window.meluli`.
