# src/preload — the renderer's only door to the main process

`index.ts` exposes `window.meluli` (typed by `src/shared/preload-api.ts`) through `contextBridge`.
Each window role (main, overlay, call) gets only its own methods. Channel names come from
`src/shared/ipc-channels.ts`; the main side checks every sender again in `src/main/security.ts`.
