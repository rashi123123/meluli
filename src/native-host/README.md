# src/native-host — Electron and Node in JavaScriptCore (D20)

The bundler (`scripts/meluli2/bundle-native-host.mjs`) maps `electron`, `node:*` and the missing
web globals to these files, so `src/main` runs unchanged inside the Swift host. Each shim calls
the host functions in `native.d.ts` (`__native`), implemented in `native/host`.

| Where | What |
|---|---|
| `globals.ts` | Timers, `TextEncoder`, `URL`, `fetch` and the rest JavaScriptCore lacks. |
| `node/` | `fs`, `child_process`, `crypto`, `os`, `path`, `events`, `stream`, `readline` and friends: only what the app uses. |
| `electron/` | `app`, `BrowserWindow`/`ipcMain`, `Menu`/`Tray`, `screen`/`shell`/`globalShortcut`; `bridge.ts` talks to `UIBridge.swift`. |
| `web/` | `fetch`, `AbortController`, `URL`. |
| `sqlite.ts` | `node:sqlite` over `HostSQLite.swift`. |
| `ipc-codec.ts` | How IPC payloads cross WebKit (JSON with typed arrays as base64). |
| `renderer/electron.ts` | The page side: `contextBridge`/`ipcRenderer` over WebKit message handlers. |

`scripts/meluli2/native-host-conformance.mjs` runs the same checks in Node and in this host and
must report 0 differences.
