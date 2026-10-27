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
creation-time cutoff. Each tick processes at most one bounded portion of one
problem, then saves its cursor. A run that spans midnight finishes its captured sweep before starting
the new day's sweep. A problem published behind an already advanced cursor
is picked up by the next sweep; this is not a simultaneous database snapshot.

Each tick is capped at 1,000 events, 4 MiB of payload bytes and 12 MiB of
serialized export. Payload size is checked before fetching bodies. Small
problems retain the ordinary JSONL archive. Larger problems continue through
numbered segments over later ticks, preserving the original terminal cursor
and root even while new events arrive. Each segment verifies its linkage from
the preceding verified root. The constant-size durable cursor retains only the
last verified event/root and segment number, not an array of the whole history.

The scheduler reports `segment-written` while a problem is incomplete and
does not increment its archived-problem count. Only the last successful segment
publishes a completion manifest, containing the terminal signature. Missing,
changed, truncated or reordered segments fail offline verification. A missing
or oversized single payload still fails explicitly; the task never increases
its memory budget to fit it. A failed scope leaves no successful receipt and
the sweep continues to other problems. Partial segment objects can remain until
the archive lifecycle expires; they are not a recoverable whole-problem archive.

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
- `backups/YYYY-MM-DD/P-…/<full-root>.segments/<number>.jsonl`: bounded
  continuation segments for a large problem.
- The adjacent `<full-root>.manifest.json`: successful completion witness for
  that segmented archive; includes its exact terminal signature and segment count.
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

## Recovering a segmented archive

Download the private manifest and its segment prefix while preserving their
storage-key paths under a local directory. Supply a public key obtained through
an independent trusted channel, not a key chosen by the archive itself:

```sh
bun scripts/assemble-ledger-backup.ts \
  --manifest ./downloaded-manifest.json \
  --segments-root ./downloaded-private-objects \
  --output ./recovered-ledger.jsonl \
  --key '<key-id>=<trusted-ed25519-public-key-hex>'
```

Assembly verifies the signature before reading segments, checks every payload,
envelope, chain link and checkpoint, and requires the exact terminal root. It
produces the ordinary v3 JSONL export plus `recovered-ledger.jsonl.checkpoints.json`.
Existing destinations are refused. This is an offline host operation: assembly
and the existing full-export restore path still need memory for the complete
problem. The scheduled Worker never assembles a whole large history in memory.
Use the existing guarded scratch restore with the latest signed deletion journal;
assembly alone does not authorize service cutover or bypass retained controls.
Run `deletionSafeRestore` from the offline operator process against its separately
validated scratch D1 binding. Require its projection result to contain `inserted`
before treating recovery as complete; a `refused` projection result leaves work
unfinished. Large recovery is a host operation, not a Worker restore RPC.

## Local verification

```sh
node apps/wire/test/integration/backup-scheduler-real-bindings.mjs
node apps/wire/test/integration/backup-segments-real-bindings.mjs
```

This journey runs the production scheduler against real local Workerd, D1 and
R2. It verifies signature waits with a fixed prefix, conditional lease races,
expired-lease recovery, replay after publication, daily completion, private
storage isolation, failure continuation after lawful redaction, rejection of
corrupt progress, and the production scheduled entrypoint. A scheduling barrier
lets both contenders read the same real R2 etag; no R2 storage operation is
mocked. The segmented journey also exceeds both event and payload budgets,
replays an interrupted segment, proves missing/tampered segments fail, and passes
the assembled export through the unchanged deletion-safe importer running on the
Node host, with a current signed deletion journal and the separate real scratch D1.
It checks the restored event count, root, payload rows and successful projection
rebuilding before declaring recovery complete.
Neither journey certifies cloud cron delivery, bucket lifecycle policies or
full SQL recovery.
