# D1 migration boundary

This directory is the sole home for numbered D1 SQL migrations. OPS.1 reserves
the layout only; it intentionally adds no tables, indexes, or data-plane
behavior.

Applied migrations are immutable. New production behavior belongs in the next
numbered file; for example, W3.5 device-flow hardening follows the already
deployed `0009_device_flow.sql` in `0010_device_flow_hardening.sql`.

When W2 begins, each migration must use the fixed name
`NNNN_short_purpose.sql`, be reviewed as SQL, and be applied by an
agent-reviewable deployment script. The Worker remains the only process that
mutates D1. Local development may use Wrangler's local persistence, but that
does not prove a migration, transaction, backup, or remote resource.
