# D1 migration boundary

This directory is the sole home for numbered D1 SQL migrations. OPS.1 reserves
the layout only; it intentionally adds no tables, indexes, or data-plane
behavior.

When W2 begins, each migration must use the fixed name
`NNNN_short_purpose.sql`, be reviewed as SQL, and be applied by an
agent-reviewable deployment script. The Worker remains the only process that
mutates D1. Local development may use Wrangler's local persistence, but that
does not prove a migration, transaction, backup, or remote resource.
