# React ledger

`App.tsx` composes navigation, hash routes, keyboard commands and update view restoration.
`store.tsx` subscribes before fetching, serializes invalidations, coalesces refreshes and accepts monotonically increasing generations. `model.ts` normalizes retained input, preserves unchanged plan objects by revision and keeps recorded stages separate from checklist progress. `preferences.ts` stores only private navigation preferences under the existing `wb-*` keys.

All native and data operations use `AgentOpsClient` (`client.ts`) over `AgentOpsBridge` from `src/shared/contracts`. The preload exposes method-specific Result/Empty calls, validates responses/events and strips Electron event objects. Main handlers are owned by the main-process integration task. No renderer module reads a file, writes a plan or registers an IPC handler.

For the independently testable interface, open `#/?fixture=demo&theme=light` (or `theme=dark`) in the built app and reload once. Other explicit sample modes are `setup`, `empty`, `hidden`, `loading`, `error` and `update`. A visible **Sample workspace** badge identifies the in-memory bridge. It never calls the real bridge for its data/native actions. Its mode remains in session storage while navigating; clear `agent-ops-ui-fixture` from session storage and remove the fixture query to return to the real bridge. The default app uses the real bridge and shows an actionable error until main modules are connected.

Run the repository npm checks. Vitest covers the state model, component output, contracts and fixture services; `npm run smoke` runs the Electron interface flows in isolated temporary profiles. Playwright fixtures reload through Electron's main-owned navigation API, keeping navigation denial enabled. No browser download or real AI profile is needed.

The original `vscode:` document launch is represented by a read-only source document/file label. The final IPC contract authorizes folder choices and fixed release/PR targets, and has no arbitrary file/URI opener. Add a separately reviewed main-resolved source-file target before restoring a document-launch action; do not construct one from renderer `root`, `file` or `spec` strings.
