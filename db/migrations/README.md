# D1 migration boundary

This directory is the sole home for numbered D1 SQL migrations. OPS.1 reserves
the layout only; it intentionally adds no tables, indexes, or data-plane
behavior.

Applied migrations are immutable. New production behavior belongs in the next
numbered file; for example, W3.5 device-flow hardening follows the already
deployed `0009_device_flow.sql` in `0010_device_flow_hardening.sql`.

Public ledger identifiers are scoped by problem (Fable Rev 3 section 6.1).
Migration `0021_problem_scoped_claim_identity.sql` repairs the original global
claim primary keys without changing the public `C-n` grammar.

Migration `0039_krater_chain_v2.sql` makes the canonical event-envelope row
digest an input to every Krater chain link and binds `chain_version: 2` into
links and checkpoints. Existing immutable v1 bytes remain as legacy audit
material; additive `event_chain_v2` and `checkpoint_chain_v2` rows are the sole
runtime integrity authority after bounded replay. An absent or mixed v2 stream
is refused, never verified under a fallback formula.

When W2 begins, each migration must use the fixed name
`NNNN_short_purpose.sql`, be reviewed as SQL, and be applied by an
agent-reviewable deployment script. The Worker remains the only process that
mutates D1. Local development may use Wrangler's local persistence, but that
does not prove a migration, transaction, backup, or remote resource.

The Worker release that introduces `flow-terminal-v1` poll replay principals
must be an atomic, forward-only cutover. Do not use a gradual old/new Worker
split or roll back to a Worker that understands only `flow:<hash>` after the
first terminal poll. The current Worker can authenticate and recover encrypted
responses written by the predecessor for the 24-hour replay-retention window;
the predecessor cannot read the new terminal namespace.
