# Nightly ledger archives

The existing five-minute Worker cron advances a daily archive of published
problem ledgers. It writes only to the private `ARTIFACTS` R2 binding; the
public artifact bucket never receives backup files. Deployment and the
provider's actual cron delivery remain operator responsibilities.

This is a **published-problem ledger archive**, not a full SQL database backup.
It excludes never-published drafts, workshops, credentials, private account
state and the global event scope. D1 Time Travel, full SQL backups, the
deletion journal, and restore drills remain separate requirements of W2.8 and
OPS.6. Do not describe this run as complete database recovery.

## Operation and limits

The first tick of a UTC day captures a finite problem-ID upper bound and a
creation-time cutoff. Each tick processes at most one problem, then saves its
cursor. A run that spans midnight finishes its captured sweep before starting
the new day's sweep. A problem published behind an already advanced cursor
is picked up by the next sweep; this is not a simultaneous database snapshot.

Each problem snapshot is capped at 1,000 events, 4 MiB of payload bytes and
12 MiB of serialized export. Payload size is checked before fetching bodies.
These bounds keep a scheduled invocation within a predictable work and memory
envelope. A larger problem records `BACKUP_LIMIT_EXCEEDED` and makes the daily
run **incomplete**; it is never reported as archived. Other problems continue.
Operators must arrange a separately bounded/streaming export for that scope.
Arbitrarily large resumable problem exports are still outstanding work.

R2 conditional writes protect the progress cursor with a ten-minute lease.
Overlapping ticks have one lease owner. If a worker dies, a later tick reclaims
the expired lease and retries. Data files use the existing content-addressed
keys, so a crash after publication but before cursor advance does not skip the
problem or mint a second logical archive. A stale owner cannot overwrite a
newer's progress. R2 puts for an export/signature pair are not a transaction;
the signature companion is written first and successful completion is recorded
only after the export is durable.

## Keys and authenticity

`CHECKPOINT_SIGNING_KEY` and `CHECKPOINT_VERIFY_KEYS` must be configured, with
the signing key's public key explicitly pinned in the verification keyring.
The checkpoint signer runs before the backup task. Missing keys return an
explicit `disabled` result; malformed, duplicate or mismatched configured keys
fail the task. Neither state means backups completed.

Before writing an archive, the Worker verifies its event/payload chain and
requires a cryptographically valid signature on the exact terminal checkpoint.
If the bounded signer has not reached that checkpoint, the scheduler records
`waiting-for-signature` and retains the exact prefix for a later tick. New
appends cannot continually move that target out of reach. Verification uses
the configured public key pins, not merely keys advertised in the backup.
The first wait time is durable. If the signature is still unavailable after
24 hours, the problem records `BACKUP_SIGNATURE_UNAVAILABLE` and the sweep
continues to other scopes; the final report is incomplete. Retries never reset
that deadline. A broken signer cannot silently stall every other archive forever.

## Storage and monitoring

- `backups/control/nightly-v1.json`: current run, cursor, pending prefix, lease,
  cumulative written/empty/failed counts, and final report pointer.
- `backups/YYYY-MM-DD/P-…/<chain-prefix>.jsonl`: verified ledger export.
- The adjacent `.checkpoints.json`: terminal signature companion.
- `backups/receipts/YYYY-MM-DD/P-…/<attempt>.json`: written/empty/failed result.
- `backups/runs/YYYY-MM-DD/<attempt>.json`: final report referenced by the
  conditional progress record. Unreferenced reports can be interrupted attempts.

Cron logs emit `stage: nightly-ledger-backup`, its explicit state, and counts.
Any export failure is recorded and the cron reports failure; a finished sweep
with failures stays `incomplete` for that day. Logs and failure receipts contain
bounded codes and identifiers, never raw SQL errors, event bodies or secrets.
A malformed progress object is refused rather than reset to a false empty run.

Configure the disclosed 90-day lifecycle only for dated archive, receipt and
run-report prefixes. Do not expire `backups/control/`, CAS, or
`journal/deletion/` through a broad `backups/` or bucket-wide rule. No lifecycle
policy or cloud resource is provisioned by this source change. Restores must
still verify and replay the latest signed deletion journal: an old archive's
presence does not authorize serving data subsequently erased or controlled.

## Local verification

```sh
node apps/wire/test/integration/backup-scheduler-real-bindings.mjs
```

This journey runs the production scheduler against real local Workerd, D1 and
R2. It verifies signature waits with a fixed prefix, conditional lease races,
expired-lease recovery, replay after publication, daily completion, private
storage isolation, failure continuation after lawful redaction, rejection of
corrupt progress, and the production scheduled entrypoint. A scheduling barrier
lets both contenders read the same real R2 etag; no R2 storage operation is
mocked. It does not certify cloud cron delivery, bucket lifecycle policies,
full SQL recovery, or streaming archives beyond the stated limits.
