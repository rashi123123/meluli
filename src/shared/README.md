# src/shared — types and rules both sides use

Imported by `src/main`, `src/preload` and `src/renderer` as `@shared/*`. No Node, Electron or DOM
calls here.

| File | What |
|---|---|
| `types.ts`, `schemas.ts` | App types and their zod schemas (IPC payload validation, settings). |
| `ipc-channels.ts`, `preload-api.ts`, `window-role.ts` | Channel names, the `window.meluli` API, window roles. |
| `locale.ts` | All Hebrew UI copy. |
| `constants.ts`, `themes.ts` | Limits, extensions, theme ids. |
| `errors/` | `AppError` and error codes. |
| `flows.ts`, `onboarding*.ts`, `call-apps.ts`, `experimental-dictation.ts` | Feature rules shared by both sides. |
| `processing-estimate.ts`, `transcript-*.ts`, `dictionary-suggestions.ts` | Pure helpers over transcripts and timing. |
| `model-manifest.json` | The ASR models, their files and hashes. |
