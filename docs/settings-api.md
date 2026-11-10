# Settings and Tasks contract

The Electron application has no HTTP API. See the [typed IPC contract](electron/ipc-contract.md),
implemented in `src/shared/contracts`. Only the trusted app window invokes it through preload.

Settings stay in `%LOCALAPPDATA%/AgentOps/config.json`, version 1. One settings store preserves
unknown keys, saves atomically and keeps newer/unreadable settings read-only. Workspace, Skills
and Tasks share that store; no independent Skills writer exists.

`tasksDir` selects `<TasksDir>/<workspace>/<plan>.md`. The app keeps `tasks-dir.txt` and the
installed-only AGENT_OPS_TASKS user variable current. Agents read that variable or pointer;
the skill contains no fixed machine path. Tests inject the environment writer.

Plan moves are owner-requested from Settings, with a backup, source recheck, no overwrite and
a report per file. Archive/Unarchive changes settings only. Delete resolves a key/revision in main
and uses the Recycle Bin; it never accepts an arbitrary renderer path.
