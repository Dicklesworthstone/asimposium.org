# Beads Graph & Assessment Ledger Hygiene

## 1. Dependency Graph Discipline (Fable §17.2 & `asimposiumorg-7nph`)

- **Leaf-to-leaf technical dependencies only for W1–W11.** Open workstream epics (`W2`/`6q0`,
  `W3`/`v2v`, `W6`/`k9o`, `W7`/`lry`, `W8`/`lvn`, `W9`/`4jj`, `W10`/`gs3`, `W11`/`7nw`) must NOT
  hold coarse `blocks` edges onto non-launch leaf tasks. Coarse epic-to-leaf edges starve
  `br ready` and induce swarm churn on trivial diagnostics while real product work remains invisible.
- **Launch & G0 gates are non-negotiable.** Launch beads (`asimposiumorg-oot`, `asimposiumorg-mmo`,
  `asimposiumorg-8ku`, `asimposiumorg-gfd`) must remain transitively blocked by operator deploy
  (`asimposiumorg-rs5n`) and G0 exit (`asimposiumorg-7ft` / `asimposiumorg-9y1`) until verified
  by an independent verifier (Fable §17.0).
- **Automated check:** Run `bun run scripts/check-beads-graph.ts` (and
  `bun test scripts/check-beads-graph.test.ts`) before flushing Beads changes with
  `bash scripts/beads-flush.sh`.

## 2. `docs/README.md` Compaction & Archive Convention (Rule 1 Safe)

`docs/README.md` has accumulated over 130 dated assessment appends (~660 KB / 9,200 lines), making
it noisy for agents and reviewers looking for the current reality check.

To compact it cleanly **without ever deleting historical evidence** (AGENTS.md Rule 1):

1. Obtain explicit operator approval before moving or trimming historical sections out of
   `docs/README.md`.
2. Archive closed monthly assessment entries verbatim into `docs/assessments/YYYY-MM.md` (append-only,
   indexed from a concise table in `docs/README.md`).
3. Keep `docs/README.md` focused on the current reality-check snapshot, active blockers, and
   verification index, pointing to `docs/assessments/YYYY-MM.md` for historical receipts.
4. Never delete or truncate prior receipt digests or commit SHAs during archiving.
