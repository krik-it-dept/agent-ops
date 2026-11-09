# Install Agent Ops

Requires Windows x64, Microsoft Edge and Node.js 24. No model/API account is needed for the dashboard or F5.

1. Quit the previous Workboard instance from its tray menu.
2. Extract the release ZIP to a temporary folder. Verify its SHA-256 against the adjacent checksum.
3. In PowerShell, run `./scripts/install.ps1` from the extracted package. It installs to `~/.claude/tools/workboard` and updates only the managed reporting instructions for Codex, Anti and Claude. Existing instructions are preserved with backups.
4. Launch `~/.claude/tools/workboard/agent-ops.exe`. Existing Workboard data and Edge profile are reused.

`-RuntimeDir <path>` and `-ProfileDir <path>` support alternate/isolated installations. `-SkipSkills` installs runtime files only. The installer validates all package entries first, backs up overwritten runtime files and does not delete task files, execution history or preferences. Quit the old process before replacing an existing executable. A failed step reports an error rather than claiming a successful installation.

Configuration flags override environment variables. Defaults retain the owner's established paths:

| Flag | Environment | Default |
| --- | --- | --- |
| `--repos-dir` | `KRIK_REPOS_DIR` | `D:/1_PROJECTS/_REPOS` |
| `--slots-file` | `KRIK_SLOTS_FILE` | `D:/1_PROJECTS/_WORKTREES/slots.json` |
| `--state-file` | `KRIK_STATE_FILE` | `D:/1_PROJECTS/tong-hop-chung.json` |
| `--script` | `KRIK_SCRIPT` | Collector beside the executable; legacy user-profile locations are fallback paths |
| `--addr` | `KRIK_ADDR` | `127.0.0.1:7790` |
| `--data-dir` | — | `%LOCALAPPDATA%/krik-workboard` |

Use `--background` to start only the tray. Start-with-Windows is an explicit tray preference; login starts the tray quietly. Persistence and the legacy protocol/run-key names remain compatible to avoid losing preferences or creating duplicate startup entries.

F5/Refresh rereads source files and execution reports. Failures retain the last good state and show the reason. It does not run an AI model or assign agents. An execution report describes an observed event; it is not proof of a currently running OS process.

Historical attribution registries are optional private runtime data and are not in the repository/release. Upgrades preserve existing registries. New installations show unreported identity until clients report actual execution.

## Rollback

Quit Agent Ops. Copy the previous runtime files from the printed `backups/<timestamp>` directory back into the runtime directory. Reporting-instruction backups are under `~/.agents/workboard-backups`. Keep the current task sources, execution directory and app-data directory; they are not code rollback targets. Relaunch the previous binary and verify `/api/state` and one F5 check.

The desktop service is loopback-only, with Host/Origin/Fetch-Metadata checks, protected POST actions, script-hash CSP and frame protection. It is not a public multi-user server and must not be exposed through a reverse proxy or port forwarding.
