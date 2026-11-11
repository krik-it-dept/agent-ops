# Asset provenance

The Agent Ops ledger artwork is original project artwork. Canonical SVG sources and approved
ICO/PNG images are in `resources/icons`. Regression tests pin their hashes and check all five
native sizes (16, 24, 32, 48 and 256 pixels).

The interface loads no external font or icon resources. It bundles one font:

- **Geist** (variable, unmodified), Copyright 2026 The Geist Project Authors
  (https://github.com/vercel/geist-font), licensed under the SIL Open Font License 1.1. The licence is
  `src/renderer/public/fonts/Geist-OFL.txt`, shipped as `out/renderer/fonts/Geist-OFL.txt`.

The small agent marks in `src/renderer/assets/icon-claude.svg`, `icon-codex.png` and `icon-anti.png`
identify the AI tools that reported work. They are trademarks of their respective owners, used only
to name those tools, and are not covered by this project's MIT licence. Other agents are shown as
text monograms.

Third-party runtime notices are supplied with packaged Electron and its dependencies.
