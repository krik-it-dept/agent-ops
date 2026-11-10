# Install Agent Ops

Agent Ops runs on Windows x64. The installed app includes its desktop runtime; Edge, Node.js
and an AI account are not required to read plans.

## Install or replace a beta

1. Download `agent-ops-setup-<version>.exe` from [Releases](https://github.com/krik-it-dept/agent-ops/releases).
2. Run it for your Windows account. The installer is unsigned, so Windows may show a warning.
   It installs in `%LOCALAPPDATA%/Programs/AgentOps` without administrator rights.
3. Open Agent Ops from Start. Complete setup or choose Set up later.

Machines with the Go beta need the new installer once. A recoverable beta copy is retained.
First start retires verified old runtime files and registrations, preserving settings/data in
`%LOCALAPPDATA%/AgentOps`. An old process that cannot be stopped safely prevents shared data
writers from starting. Plan sources are never removed by migration.

## Workspace, Skills and Tasks

Add work folders in Settings > Workspace. Choose Skills folders to receive the shared plan
format. Installation, update, replacement and removal keep backups and protect locally changed
files. Instruction reminders are optional; text outside the managed reminder is preserved.

Choose one Tasks folder. Plans use `<Tasks folder>/<workspace>/<plan>.md`. The app keeps
`%LOCALAPPDATA%/AgentOps/tasks-dir.txt` and the installed-only `AGENT_OPS_TASKS` user variable
current; programs started later see the updated variable.

Changing Tasks asks whether to move plans from the previous Tasks folder. Older workspace plans
have a separate Move them here action. Both keep backups, never overwrite and report each file.
Skills keep working after the folder changes.

## Everyday use

Closing the window hides it in the notification area. Open it there or from Start; choose Quit
in the tray menu to exit. Start with Windows and desktop notifications are optional. F5 rereads
files without an AI call.

Archive/Unarchive changes only the app's list. Delete confirms the file and moves it to the
Windows Recycle Bin. A file changed in the last milliseconds after the final check may still be
recycled; it remains recoverable from the Recycle Bin.

## Updates and troubleshooting

Published stable releases appear in About and the update notice. Update and restart downloads
and checks the installer, then restarts automatically after a short notice. Failed handoff leaves
the app usable. Development copies do not check for updates.

Settings/backups are in `%LOCALAPPDATA%/AgentOps`. About copies diagnostics without plan text
or folder names and opens local logs. Keep data and plan folders when repairing/reinstalling;
do not replace newer settings with an older app's data.

Support can run `agent-ops.exe --health-check`: no window, read-only config/resource checks,
one JSON result and exit 0/1. It does not change the checked data. The installer does not yet
use it as a bootstrap commit gate.

## Uninstall

Use Windows Settings > Apps > Agent Ops > Uninstall. Optional managed-Skills and app-data removal
default to keeping both. Modified Skills are kept. The Tasks folder and plans are never deleted.
Owned startup/protocol entries and the Tasks user variable are removed.

See [development](docs/development-electron.md) and [install/update](docs/install-and-update.md).
