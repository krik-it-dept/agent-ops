# Desktop interface refresh

The reference is the local Orca repository: `docs/STYLEGUIDE.md`, the color and component guides, `src/renderer/src/assets/main.css`, and the button primitive. Agent Ops keeps its vanilla frontend and independently adapts the surface hierarchy and interaction patterns to an execution monitor.

- The dark canvas is charcoal, with a lighter sidebar and subtle raised panels. Light mode uses an off-white canvas, pale gray sidebar and white panels. Navigation is neutral; color identifies execution state.
- Geist is bundled, licensed and served locally. Task titles use the main text color rather than a full table of blue links. Secondary labels stay muted and data uses tabular numbers.
- New browser profiles start on Summary. Saved layouts remain intact. Current work shows recorded next actions and opens plan previews directly; attention sorts first. Completed plans follow active plans in the sidebar.
- Ctrl+K searches plans and commands, including Vietnamese without accents and plan names with hyphens. Up/Down changes selection, Enter opens the result, and Escape closes the dialog and restores focus. It never writes task sources or infers execution.
- Ctrl+1/2/3/4 switches Summary/List/Board/Timeline, Ctrl+B toggles the plans sidebar, `/` filters the current view, F5 refreshes, Ctrl+, opens Settings, and Ctrl+F searches Settings. Single-key shortcuts respect the existing preference and ignore typing fields.
- Plan previews retain stable previous/next navigation, work/activity tabs, source-backed progress, and collapsed completed evidence. A hidden error banner cannot produce a false preview error from its button labels.

Validation uses isolated task roots, settings, profiles and ports. The rendered review covers both themes, all four views, command search, plan preview, filtering, Settings, keyboard focus, and 1600x1000 / 900x800 / 600x800 windows. No data hierarchy, acceptance state or ownership migration is part of this change.
