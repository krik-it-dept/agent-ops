# Install and update Agent Ops

Agent Ops is installed per user, without administrator rights, from one installer file. It updates itself
from the public GitHub releases of `krik-it-dept/agent-ops`; no GitHub account, GitHub CLI or token is needed.

## Install

1. Open the [latest release](https://github.com/krik-it-dept/agent-ops/releases/latest) and download
   `agent-ops-setup-<version>.exe`.
2. Open the file. The installer is not code signed (an owner decision: trust rests on HTTPS and the GitHub
   account), so Windows SmartScreen may show **Windows protected your PC**. Choose **More info**, check that
   the file came from the release page above, then choose **Run anyway**.
3. The installer runs without questions and starts Agent Ops when it is done.

What the installer does:

| Item | Where |
| --- | --- |
| Program files | `%LOCALAPPDATA%\Programs\AgentOps` |
| Start menu shortcut | **Agent Ops** (AppUserModelID `KrikIT.AgentOps`, used by notifications) |
| Apps & features entry | **Agent Ops**, with its uninstaller |
| Link protocol | `agent-ops:` (opens a plan from a notification) |
| Your settings and data | `%LOCALAPPDATA%\AgentOps` (kept on update and, unless you choose otherwise, on uninstall) |

Start with Windows is off for a new install and can be turned on in Settings.

## Updates

Agent Ops checks for a new release about three seconds after it starts, every six hours, and when you choose
**Check for updates** in Settings > About. A check never downloads anything. When a newer release exists, a
small notice shows its version and notes with **Update and restart** and **Skip this version**.

- **Update and restart** downloads the update in the background (you can minimise the notice and keep
  working), checks it against the SHA-512 published with the release, then shows a short notice and restarts
  Agent Ops by itself to install it. Your settings and data are kept.
- **Skip this version** hides that version; a newer one is offered again.
- Without internet, or when GitHub limits requests, the check says so and tries again later. A download that
  does not match its checksum is discarded; the running app is not changed.
- Development builds and builds with a dev version (`x.y.z-dev.N`) never check for updates.

Closing Agent Ops never installs a downloaded update; only **Update and restart** does.

If the downloaded installer cannot be started (for example an antivirus removed it), Agent Ops does not quit:
it shows that the update could not be installed and keeps running, and **Update and restart** can be tried
again. If an update started but did not finish, Agent Ops says so on the next start. You can always download
the latest installer and run it: it installs over the existing copy and keeps your data.

## Uninstall

Use **Settings > Apps > Installed apps > Agent Ops > Uninstall**. The uninstaller asks whether to delete your
settings and data in `%LOCALAPPDATA%\AgentOps`; the default (**No**) keeps them. It removes the program files,
the shortcut, the Start with Windows entry, the `agent-ops:` protocol, the notification registration and the
`AGENT_OPS_TASKS` variable. The Tasks folder and its plans are never deleted. **Also remove Agent Ops skills
from your AI tools?** defaults to **No**. Choose **Yes** to run the app's guarded Skills cleanup after the app
has stopped, before its executable and data are removed. Modified files are kept; if cleanup fails, a message
explains that uninstall continues and any remaining skills need review in your AI tools.

The uninstaller works only on `%LOCALAPPDATA%\Programs\AgentOps` and refuses (removing nothing) when that
folder holds a link or junction. Your data is never deleted through a link: if `%LOCALAPPDATA%\AgentOps`
contains one, the data is kept and a message says so.

## Moving from the Go beta (v0.2.x to v0.4.0) to v1.0.0

Run the new installer once; the Go beta has no in-app update to this version. Your settings and data are
kept.

- **The install folder.** Agent Ops installs only into `%LOCALAPPDATA%\Programs\AgentOps`. A `/D=` folder or
  a recorded location elsewhere is refused, as is a link or junction in the install folder or in the data
  paths the installer writes; nothing is changed then.
- **A running copy.** Setup closes only a process whose program file is exactly the `agent-ops.exe` it is
  about to replace (checked by file identity, so another copy in a neighbouring or nested folder is never
  touched). If it cannot check or close one, setup stops without changing anything and asks you to close
  Agent Ops yourself.
- **The Go beta in `%LOCALAPPDATA%\Programs\AgentOps`** is replaced as a recoverable step: setup first writes
  and verifies a journal (`%LOCALAPPDATA%\AgentOps\legacy-move\go-install-journal.txt`), closes the beta,
  moves its folder whole to `%LOCALAPPDATA%\AgentOps\backups\go-install-<time>` and checks the move. Only
  when all new files are in place is the step committed. If setup stops before that (disk full, power loss,
  a failed extraction), simply run the installer again: it finds the journal, puts the beta back (keeping any
  half-written new files beside the backup) and starts over. Nothing of the beta is deleted.
- **On its first successful start** the new app retires the rest: the beta's Apps & features entry, the old
  startup and protocol entries (when Start with Windows was on it stays on for the new app), and the old
  runtime folder `%USERPROFILE%\.claude\tools\workboard` (from releases up to v0.2.x), which is renamed to
  `<folder>.backup-<time>` when it holds more than the no-op `task-sync.mjs` and `task-report.mjs`; those two
  stay at the old path for older sessions. Only the two exact old program files in that folder are closed
  first. `config.json` of `%LOCALAPPDATA%\krik-workboard` is copied once when `%LOCALAPPDATA%\AgentOps` has
  none.
- `%LOCALAPPDATA%\AgentOps` (settings, archive state, backups) is otherwise left as it is. Nothing is deleted:
  old folders are renamed next to where they were.
- Every step is logged in `%LOCALAPPDATA%\AgentOps\logs\installer.log` and
  `%LOCALAPPDATA%\AgentOps\legacy-move\legacy-move.log`; a step that failed is retried on the next start.

## Releasing (owner)

The release workflow `.github/workflows/release.yml` builds a draft; nothing reaches installed apps
until you publish it.

1. On `main`, set `version` in `package.json` to the new version (for example `1.0.0`) and add a
   `## v1.0.0 - <title>` section to `CHANGELOG.md`; its text becomes the release notes.
2. Push a tag `v1.0.0` on that commit. The workflow refuses a tag that is not on `main`, does not equal the
   `package.json` version or has no `CHANGELOG.md` section.
3. The build job runs `npm ci`, typecheck, lint, tests, the build, the Electron smoke test, packages the
   installer and smoke-tests the packaged app in an isolated data folder. It holds only a read token.
4. The publish job checks that the installer still matches `latest.yml` and creates a **draft** release with
   `agent-ops-setup-<version>.exe`, its `.blockmap` and `latest.yml`.
5. Review the draft (notes, assets), install it on a test account if you want, then **Publish**. Installed
   apps see it at their next check. Never delete or replace the assets of a published release: installed apps
   compare the installer with `latest.yml`.

A run started by hand (**Run workflow**) on any branch packages a dev version (`<version>-dev.<run>`) for
testing and publishes nothing. Locally: `npm run build`, then `npm run package` (installer in `dist/electron`)
or `npm run package:dir` (unpacked app only). Run `npm run smoke:packaged` after the installer build, or
`npm run smoke:packaged -- --dir` after an unpacked-only build. The latter checks the app and resources
without requiring installer update metadata or running NSIS.

Before the first Electron release tag, the Go release workflow (`release.yml`, also triggered by `v*` tags)
must be retired.
