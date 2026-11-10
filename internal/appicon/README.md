# Agent Ops ledger mark

Original artwork: three ledger rows with a completion check. The monochrome
geometry is designed for the neutral interface and remains readable at 16px.

- `source-light.svg`: charcoal mark for light surfaces, transparent background.
- `source-dark.svg`: off-white mark for dark surfaces, transparent background.
- `source-tile.svg`: off-white mark on a charcoal rounded tile with a grey rim,
  for the executable, toast and tray fallback on either taskbar theme.

Run `go run ./cmd/icon` from the repository root to regenerate the PNG and ICO
assets under `web/icons`. SVG is the source of truth; `icon.go` rasterizes its
rounded rectangles and round three-point polyline with 8x supersampling using
only the Go standard library. Keep artwork within that documented SVG subset.
The earlier owner-supplied cobalt robot `source.png` is no longer in the tree; it remains in git history.

Use `go run ./cmd/icon -preview-dir <directory>` to also render each variant at
256, 32 and 16px on white and #0a0a0a backgrounds. The executable embeds the tile
at 16, 24, 32, 48 and 256px; `-verify-exe <exe>` checks every native image.

In-app marks follow the saved light/dark/system setting using CSS. The browser
favicon follows the browser color scheme. The tray queries Windows'
`SystemUsesLightTheme` read-only every 30 seconds and uses the matching mark;
unknown or unavailable values fall back to the tile. Toast extraction continues
to use `web/icons/app.png`. All runtime images are embedded, so no updater runtime
file-list change is needed.
