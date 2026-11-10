# Frozen plan reader regression fixtures

These synthetic plans and committed `expected/*.json` are frozen regression inputs. The original
expected outputs came from the Go beta at `38c840b`, with edge/short-junction corpora added during
the TypeScript migration. They contain no owner runtime data. The Go generator is retired and
normal tests require only Node, never a Go compiler.

Matching the retired beta is not an acceptance criterion. Existing expected JSON remains unchanged
to catch accidental reader regressions. Deliberate improvements to the new app should update a
focused test and explain the user benefit; do not recreate a beta quirk just for parity.

`manifest.json` describes ten collections. Tests copy a corpus into a new temporary folder,
create declared empty/oversized files and junctions, inject read failures and compare the overview
with its frozen expected JSON. Only temporary roots/timestamps are normalized. Corpus bytes are
excluded from text conversion to preserve CRLF, BOM, invalid UTF-8 and revision hashes.

The edge corpus covers Unicode line/space handling, headers, estimates, steps, fences, milestones,
decisions/questions and malformed bytes. The short-junction corpus exercises Windows junctions
and 8.3 names, and is skipped when those names are unavailable. All filesystem effects stay in the
temporary copy. Other TypeScript tests cover Git timeout/cancellation, origin reads and inherited
environment isolation; the UI does not expose that implementation metadata.

The public reader is `src/main/modules/plans/index.ts`: collectOverview reads explicitly supplied
Tasks/workspace roots with cancellation, and parsePlan parses text/bytes. No default owner folder
or live AI profile is read by fixture tests. The immutable JSON records no new hierarchy or
acceptance states, and the compatibility `repos[].worktrees` array remains empty.
