# Meeting Recorder Stabilization Tasks

## Immediate Tasks

- [x] Add resilient permission checks with timeout and parse safeguards.
- [x] Add recorder preflight validation for selected output folder writability.
- [x] Fix recorder stdout parsing to handle chunked/partial JSON lines safely.
- [x] Surface recorder startup/process errors to the UI with actionable messages.
- [x] Improve main-process startup/IPC error handling and development diagnostics.
- [x] Keep recording UI controls consistent after start/stop/failure transitions.

## Next Tasks

- [ ] Migrate from `nodeIntegration` to `preload` + `contextIsolation`.
- [ ] Replace CDN-loaded frontend dependencies with bundled local assets.
- [ ] Add signing/notarization pipeline and macOS entitlements for release builds.
- [ ] Add automated tests for recording lifecycle and transcript processing.
