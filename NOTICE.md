# Asset provenance

- Agent Ops ledger app artwork: original SVG artwork created for this project in `internal/appicon/source-{light,dark,tile}.svg`; reproducibly rasterized with Go. The earlier owner-supplied cobalt robot artwork is no longer in the tree and remains in git history.
- Codex/OpenAI mark: installed OpenAI Codex desktop package.
- Claude mark: https://claude.com/icon.svg
- Antigravity mark: https://antigravity.google/press
- Interface font: Geist variable WOFF2, bundled from the local Orca source checkout (`src/renderer/src/assets/fonts/Geist-Variable.woff2`). Geist is distributed under the SIL Open Font License 1.1; the license is embedded at `/fonts/OFL.txt` (source: https://github.com/vercel/geist-font/blob/main/OFL.txt). Code/path text uses the operating system monospace stack.

Product names and marks identify the reporting clients. Runtime use does not require network access for icons or fonts. The interface is independently implemented in vanilla CSS/JavaScript, informed by the Orca style guide and surface hierarchy; no Orca application components are copied.
