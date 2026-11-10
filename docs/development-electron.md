# Electron development

Use Node.js 24 from `.nvmrc` and locked dependencies from `npm ci`. Go is retired.

```powershell
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run package
npm run smoke:packaged
```

Development uses `.dev-data` or absolute local `AGENT_OPS_DATA_DIR`. Never use installed data,
real AI client files, the registry or the installed app for tests. The installed data folder is
`%LOCALAPPDATA%/AgentOps`; Chromium, logs and crashes have separate subfolders. Tests inject
temporary data/profiles and fake native effects.

Main composes modules under `src/main/modules`. The IPC registry uses RequestMap/ResponseMap/
EventMap from `src/shared/contracts`, validates payloads and the owning top frame and returns
Result. Preload exposes named methods, validates replies and strips native events. A private
renderer-ready handshake queues initial activation until the reader and React listeners are ready.
React has no Node access.

Production uses `app://agent-ops/index.html`, strict response-header CSP and local assets.
Navigation, new windows, permissions, downloads and webviews are denied. Native opening accepts
only known folders or fixed release/plan-link targets. Vite permits its loopback HMR socket and
injected development styles only.

`AGENT_OPS_UI_FIXTURES=1` enables labelled sample data in unpackaged development. A sample URL
or saved preference alone has no effect; packaged builds ignore the flag. The separate E2E entry
injects native/provider fakes only for an explicitly flagged temporary data root. No test handlers
or raw IPC method are exposed to the renderer.

Build writes `out/`. Package writes `dist/electron`, installs nothing and publishes nothing.
Packaged smoke checks real setup/ledger/Result IPC and sample denial, then proves headless health
leaves the temporary data unchanged. It never runs NSIS. Real install/uninstall, modal picker,
Recycle Bin restore and published-release update checks need a disposable Windows account/VM.

See [integration](electron/integration.md), [IPC](electron/ipc-contract.md) and
[install/update](install-and-update.md). Reader fixtures are frozen regression inputs; tests
need no Go compiler or access to the owner's plans.
